import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
vi.mock("server-only", () => ({}));
const store = vi.hoisted(() => ({
  records: new Map<string, { id: string; inputDigest: string; result: unknown }>(),
  paid: new Map<string, { stepId: string; data: unknown }>(),
  binding: null as unknown, candidate: null as unknown, candidateStepId: "", insideTransaction: false,
}));
vi.mock("@/server/course-generation/repository", async () => {
  const { taskDigest } = await import("@/server/mechanics/digest");
  return {
    GenerationEvidenceRepository: class {
      async loadBinding(_tx: unknown, input: { runId: string; ownerId: string }) {
        const binding = store.binding as ApprovedBuildBinding;
        if (input.runId !== binding.run.id || input.ownerId !== binding.course.ownerId) throw new Error("binding mismatch");
        return structuredClone(binding);
      }
      async loadTaskCandidate(_tx: unknown, _binding: unknown, stepId: string) {
        if (stepId !== store.candidateStepId) throw new Error("candidate step mismatch");
        return { candidate: structuredClone(store.candidate) };
      }
    },
    async loadGenerationStep<T>(_tx: unknown, _binding: unknown, stepId: string, schema: z.ZodType<T>) {
      const record = store.records.get(stepId);
      if (!record) throw new Error("missing stored step");
      return { ...record, result: schema.parse(structuredClone(record.result)) };
    },
    async verifyStoredModelData<T>(_tx: unknown, step: { id: string }, operationId: string, schema: z.ZodType<T>, expected: T) {
      const paid = store.paid.get(operationId);
      if (!paid || paid.stepId !== step.id || taskDigest(schema.parse(paid.data)) !== taskDigest(expected)) throw new Error("stored provider evidence mismatch");
    },
  };
});
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { ModelPort, StructuredRequest, ModelResult } from "@/server/ai/ports";
import type { RunContext, StepEffectContext } from "@/server/runs/ports";
import type { JsonValue } from "@/domain/common";
import { ActivitySessionPublicSchema } from "@/domain/activity";
import { RubricRequestSchema } from "@/server/evaluation/contracts";
import { advanceActivityCase, replayStoredActivityCase, ActivityActionCheckpointSchema, ActivityDraftCheckpointSchema } from "@/server/course-validation/activity-cases";
import { type ResponseCase, type CaseEvaluationResult } from "@/server/course-validation/case-evaluation";
import { prepareTaskCasesCheckpoint } from "@/server/course-generation/checkpoints";
import { stableExecutionId } from "@/server/runs/identity";
import { jsonDigest } from "@/server/ai/json";
import { MODEL_ID, PROVIDER_TAG } from "@/server/ai/constants";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { authored, registryFixtures, approvalDigest } from "../mechanic-registry/fixtures";
import { id } from "./fixtures";

beforeEach(() => { store.records.clear(); store.paid.clear(); store.insideTransaction = false; });
function raw(value: JsonValue): JsonValue {
  const result = structuredClone(value);
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    for (const key of ["commitReceiptId", "observationReceiptId"]) if (key in result) result[key] = null;
    for (const key of ["observationReceiptIds", "turnReceiptIds"]) if (key in result) result[key] = [];
  }
  return result;
}
async function setup(mechanicId = "outcome_prediction") {
  const fixture = registryFixtures.find((entry) => entry.id === mechanicId)!;
  const sample = await fixture.make();
  const candidate = prepareTaskCandidate(authored(sample, fixture.dimensions), { approvalDigest });
  const binding = { run: { id: id(701) }, course: { id: id(702), ownerId: id(703) }, version: { id: id(704) }, approval: { contentDigest: approvalDigest } } as ApprovedBuildBinding;
  const candidateStepId = id(705), casePlanStepId = id(706), planOperation = id(707);
  const actions = sample.activity?.session.events.map((event, index) => ({ key: `action_${index}`, action: event.action,
    response: raw(sample.activity!.receiptInputs[index]!.response) })) ?? [{ key: "run", action: { kind: "run" as const }, response: raw(sample.response) }];
  const proposal = { cases: [
    { key: "valid", category: "valid" as const, response: raw(sample.response), activityPlan: { actions } },
    { key: "invalid", category: "invalid" as const, response: {}, activityPlan: { actions } },
    { key: "alternative", category: "alternative" as const, response: raw(sample.response), activityPlan: { actions } },
  ], alternativeSpaceProof: null };
  const checkpoint = prepareTaskCasesCheckpoint({ candidateStepId, candidateDigest: candidate.candidateDigest, operationId: planOperation, proposal });
  store.binding = binding; store.candidate = candidate; store.candidateStepId = candidateStepId;
  store.records.set(casePlanStepId, { id: casePlanStepId, inputDigest: "b".repeat(64), result: checkpoint });
  store.paid.set(planOperation, { stepId: casePlanStepId, data: proposal });
  const index = new Map<string, string>(), calls: Array<{ schemaId: string; stepId: string; operationId: string }> = [];
  const signal = new AbortController().signal;
  const tx = {} as Parameters<Parameters<RunContext["read"]>[0]>[0];
  const context: RunContext = {
    claim: { jobId: id(708), leaseOwner: "fixture", fencingToken: "1", retryEpoch: 0, target: { kind: "generation", runId: binding.run.id,
      ownerId: binding.course.ownerId, conversationId: id(709), branchId: id(710), inputMessageId: id(711), courseId: binding.course.id,
      approvalId: id(712), approvalDigest, courseVersionId: binding.version.id } }, signal,
    async read(reader) { store.insideTransaction = true; try { return await reader(tx, this.claim.target); } finally { store.insideTransaction = false; } },
    async step(spec) {
      const stepId = stableExecutionId(this.claim.jobId, spec.key);
      const effect: StepEffectContext = { stepId, signal, deadlineAt: Date.now() + 10000,
        stepFence: { jobId: this.claim.jobId, jobLeaseOwner: "fixture", jobFencingToken: "1", retryEpoch: 0, stepId, stepLeaseOwner: "fixture", stepFencingToken: "1" },
        budgetOperation(name) { const logicalOperationId = stableExecutionId(stepId, name); return { logicalOperationId,
          reservationId: stableExecutionId(logicalOperationId, "attempt:1"), attempt: 1, runStepId: stepId, probe: false }; } };
      const output = spec.outputSchema.parse(await spec.effect(effect, spec.input));
      store.insideTransaction = true;
      let result;
      try { result = spec.resultSchema.parse(await spec.commit(tx, output)); } finally { store.insideTransaction = false; }
      store.records.set(stepId, { id: stepId, inputDigest: jsonDigest(spec.input), result }); index.set(spec.key, stepId);
      return result;
    },
    async emitChat() { throw new Error("No learner/chat writes"); }, async emitGeneration() { throw new Error("No observer writes in this producer"); },
    async completeTurn() { throw new Error("No turn completion"); }, async completeGeneration() { throw new Error("No course publication"); },
  };
  const model: ModelPort = {
    capabilities() { throw new Error("No capability simulation needed"); }, async *streamText() { throw new Error("No text stream"); },
    async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
      expect(store.insideTransaction).toBe(false);
      const runStepId = request.budget.runStepId;
      if (runStepId === null) throw new Error("A paid authoring effect requires a persisted step");
      calls.push({ schemaId: request.schemaId, stepId: runStepId, operationId: request.budget.reservationId });
      let data: unknown;
      if (request.schemaId === "learning_dialogue_draft") {
        const facts = sample.privateData.hiddenFacts as Array<{ id: string; text: string }> | undefined;
        data = { text: facts?.[0]?.text ?? "A bounded partner reply.", revealedFactIds: facts?.map((fact) => fact.id) ?? [] };
      } else if (request.schemaId === "learning_dialogue_audit") {
        const facts = sample.privateData.hiddenFacts as Array<{ id: string }> | undefined;
        const rules = sample.privateData.disclosureRules as Array<{ id: string }>;
        data = { verdict: "allowed", inspectedEntirePartnerText: true, noForbiddenDisclosure: true, noGoalAnswerDisclosure: true,
          compliesWithScenarioConstraints: true, noUnsupportedCommitment: true,
          factDecisions: facts?.map((fact) => ({ factId: fact.id, allowed: true, ruleIds: [rules[0]!.id], rationale: "Synthetic semantic judgement for wiring only." })) ?? [],
          explanation: "Synthetic semantic audit for wiring only." };
      } else {
        const rubric = RubricRequestSchema.parse(request.untrustedInput);
        data = { dimensions: rubric.rubric.dimensions.map((dimension) => ({ id: dimension.id, status: "met", evidenceRefs: [{ responsePath: rubric.allowedResponsePaths[0], span: null }], explanation: "Synthetic rubric verdict for wiring only." })), feedback: "Synthetic rubric result.", uncertainReasons: [] };
      }
      const parsed = request.schema.parse(data);
      store.paid.set(request.budget.reservationId, { stepId: runStepId, data: structuredClone(parsed) });
      return { data: parsed, evidence: { operationId: request.operationId, reservationId: request.budget.reservationId, providerRequestId: "synthetic",
        requestedModel: MODEL_ID, returnedModel: MODEL_ID, provider: PROVIDER_TAG, finishReason: "stop", rateCardDigest: "a".repeat(64), replayed: false,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: null, cachedPromptTokens: null, searchRequests: 0, costUsd: "0" } } };
    },
  };
  const input = { context, binding, index, candidateStepId, casePlanStepId, candidate, test: checkpoint.cases[0]!, model: null as ModelPort | null };
  const drain = async () => {
    for (let count = 0; count < 80; count++) {
      const before = index.size, paidBefore = calls.length;
      const result = await advanceActivityCase(input);
      expect(index.size - before).toBeLessThanOrEqual(1); expect(calls.length - paidBefore).toBeLessThanOrEqual(1);
      if (result) return result;
    }
    throw new Error("Producer did not terminate");
  };
  const replay = (result: { stepId: string; result: CaseEvaluationResult }) => replayStoredActivityCase(tx, binding, candidate, result.result,
    { ...store.records.get(result.stepId)!, result: result.result });
  const mutateTest = (edit: (test: ResponseCase) => void) => {
    edit(input.test);
    const stored = store.records.get(casePlanStepId)!.result as typeof checkpoint;
    stored.cases[0] = structuredClone(input.test);
    const { caseId: _caseId, ...proposed } = input.test; void _caseId;
    proposal.cases[0] = proposed as typeof proposal.cases[0];
  };
  return { input, drain, replay, mutateTest, calls, model, checkpoint };
}

describe("stored authoring activity cases", () => {
  it.each(["outcome_prediction", "constrained_optimization", "artifact_construction", "causal_intervention"])("executes %s through actual deterministic actions and replays without provider calls", async (mechanic) => {
    const harness = await setup(mechanic), result = await harness.drain();
    expect(result.result.decision?.outcome).toBe("correct"); expect(result.result.activityEvidenceRef).not.toBeNull();
    expect(result.result.modelCallId).toBeNull(); expect(harness.calls).toEqual([]);
    const terminal = ActivityActionCheckpointSchema.parse(store.records.get(result.result.activityEvidenceRef!)!.result);
    expect(ActivitySessionPublicSchema.safeParse({ id: terminal.input.activitySessionId }).success).toBe(false);
    expect(terminal.event.receipt.status).toBe("completed");
    await expect(harness.replay(result)).resolves.toBeUndefined();
    const count = harness.input.index.size;
    expect(await advanceActivityCase(harness.input)).toEqual(result); expect(harness.input.index.size).toBe(count);
  });
  it("rejects invented receipt UUIDs before creating any action step", async () => {
    const harness = await setup();
    harness.mutateTest((test) => { (test.response as Record<string, JsonValue>).commitReceiptId = id(999); });
    await expect(advanceActivityCase(harness.input)).rejects.toThrow("provider.invalid_output");
    expect(harness.input.index.size).toBe(0);
  });
  it("rejects altered observations, reordered chains and changed final inputs on replay", async () => {
    const harness = await setup(), result = await harness.drain();
    const record = store.records.get(result.result.activityEvidenceRef!)!, original = structuredClone(record.result);
    const altered = ActivityActionCheckpointSchema.parse(record.result);
    if (altered.event.receipt.observation?.kind !== "values") throw new Error("Expected observation");
    altered.event.receipt.observation.values[0]!.quantity.value += 1; record.result = altered;
    await expect(harness.replay(result)).rejects.toThrow("provider.invalid_output");
    record.result = structuredClone(original);
    const chain = ActivityActionCheckpointSchema.parse(record.result); chain.priorActionStepIds = [chain.runStepId]; record.result = chain;
    await expect(harness.replay(result)).rejects.toThrow("provider.invalid_output");
    record.result = original;
    const response = structuredClone(result); (response.result.response as Record<string, JsonValue>).interval = { lower: 999, upper: 999, unit: "unitless" };
    await expect(harness.replay(response)).rejects.toThrow("provider.invalid_output");
  });
  it("rejects changed candidate/approval/case joins and action-budget overrun", async () => {
    const harness = await setup("causal_intervention");
    const badCandidate = structuredClone(harness.input.candidate); badCandidate.task.instruction += " altered";
    await expect(advanceActivityCase({ ...harness.input, candidate: badCandidate })).rejects.toThrow("provider.invalid_output");
    const target = harness.input.context.claim.target;
    if (target.kind !== "generation") throw new Error("Expected generation");
    target.approvalDigest = "c".repeat(64);
    await expect(advanceActivityCase(harness.input)).rejects.toThrow("provider.invalid_output"); target.approvalDigest = approvalDigest;
    const wrongTest = { ...harness.input.test, caseId: id(999) };
    await expect(advanceActivityCase({ ...harness.input, test: wrongTest })).rejects.toThrow("provider.invalid_output");
    harness.mutateTest((test) => { const action = test.activityPlan!.actions[0]!; test.activityPlan!.actions = Array.from({ length: 24 }, (_, index) => ({ ...action, key: `q${index}` })); });
    await expect(harness.drain()).rejects.toThrow("provider.invalid_output");
    expect(harness.calls).toHaveLength(0);
  });
  it("persists dialogue draft and audit as separate paid steps, then verifies their exact stored output before rubric replay", async () => {
    const harness = await setup("information_gap"); harness.input.model = harness.model;
    const result = await harness.drain();
    expect(result.result.decision, JSON.stringify(result.result.decision)).toMatchObject({ outcome: "correct" });
    expect(harness.calls.map((call) => call.schemaId)).toEqual(["learning_dialogue_draft", "learning_dialogue_audit", "rubric_judgement"]);
    expect(new Set(harness.calls.map((call) => call.stepId)).size).toBe(3);
    await harness.replay(result); expect(harness.calls).toHaveLength(3);
    const draftRecord = [...store.records.values()].find((record) => ActivityDraftCheckpointSchema.safeParse(record.result).success)!;
    const draft = ActivityDraftCheckpointSchema.parse(draftRecord.result); draft.draft.text = "A forged partner reply."; draftRecord.result = draft;
    await expect(harness.replay(result)).rejects.toThrow("stored provider evidence mismatch");
  });
  it("never records a completed dialogue observation when the stored semantic audit rejects it", async () => {
    const harness = await setup("information_gap"); harness.input.model = harness.model;
    expect(await advanceActivityCase(harness.input)).toBeNull();
    expect(await advanceActivityCase(harness.input)).toBeNull();
    const auditRecord = [...store.records.values()].find((record) => (record.result as { kind?: string }).kind === "course.activity.audit")!;
    const audit = auditRecord.result as { operationId: string; audit: { verdict: string } };
    audit.audit.verdict = "rejected"; store.paid.get(audit.operationId)!.data = structuredClone(audit.audit);
    await expect(advanceActivityCase(harness.input)).rejects.toThrow("provider.invalid_output");
    expect([...store.records.values()].some((record) => ActivityActionCheckpointSchema.safeParse(record.result).success)).toBe(false);
    expect(harness.calls).toHaveLength(2);
  });
});
