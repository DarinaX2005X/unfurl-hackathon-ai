import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { CurriculumValidationFailure, CurriculumValidationFeedbackSchema } from "../../src/server/curriculum-research/validation-feedback";
import * as composer from "../../src/server/curriculum-research/durable-composer";
import * as parts from "../../src/server/curriculum-research/part-runtime";
import * as instructionPolicy from "../../src/server/curriculum-research/instruction-policy";
import { researchInstructions } from "../../src/server/curriculum-research/composer";
import * as repository from "../../src/server/agent-turns/repository";
import { executeAgentTool } from "../../src/server/agent-tools/executor";
import { PostgresResearchRepository } from "../../src/server/research/repository";
import { ProviderFailure } from "../../src/server/ai/failure";
import { jsonDigest } from "../../src/server/ai/json";
import { MODEL_ID, MODEL_POLICY_VERSION } from "../../src/server/ai/constants";
import type { ModelPort, StructuredRequest } from "../../src/server/ai/ports";
import type { RunContext, StepEffectContext } from "../../src/server/runs/ports";
import type { DbTransaction } from "../../src/server/db";
import { ids, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
const feedback = { code: "claim_outcome_mismatch" as const, path: ["outcomeEvidence", 1, "claimRefs", 0] as ["outcomeEvidence", number, "claimRefs", number],
  claimRef: "actual-claim", expectedOutcomeId: ids.outcomeB, declaredOutcomeIds: [ids.outcomeA], researchPart: { phase: "research" as const, index: 0 } };
const target = { kind: "agent_turn" as const, runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.missing };

function harness() {
  const saved = new Map<string, parts.SavedCurriculumPart>(), events: unknown[] = [], requests: StructuredRequest<unknown>[] = [];
  const tx = { query: async () => { throw new Error("No database calls in this contract test"); } } as unknown as DbTransaction;
  const model = { generateStructured: async (request: StructuredRequest<unknown>) => { requests.push(request); return { data: request.schema.parse({ value: "candidate" }) }; } } as unknown as ModelPort;
  const context = { claim: { jobId: ids.task, target }, signal: new AbortController().signal,
    read: async <T>(work: (tx: DbTransaction, selectedTarget: typeof target) => Promise<T>) => work(tx, target),
    async step(spec) {
      const effect: StepEffectContext = { stepId: ids.task, deadlineAt: 1234, signal: new AbortController().signal,
        stepFence: { jobId: ids.task, jobLeaseOwner: "test", jobFencingToken: "1", retryEpoch: 0, stepId: ids.task, stepLeaseOwner: "test", stepFencingToken: "1" },
        budgetOperation: () => ({ logicalOperationId: ids.task, reservationId: ids.task, runStepId: ids.task, attempt: 1, probe: false }) };
      const output = spec.outputSchema.parse(await spec.effect(effect, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      saved.set(spec.key, { step_key: spec.key, input_digest: jsonDigest(spec.input), schema_digest: spec.digests.schema,
        capability_digest: spec.digests.capability, validation_policy_digest: spec.digests.validationPolicy, approval_digest: spec.digests.approval, result_reference: result });
      return result;
    },
    emitChat: async (_tx, event) => { events.push(event); return { ...event, id: ids.task, runId: target.runId, branchId: target.branchId, seq: 1, at: now }; },
  } as RunContext;
  return { context, model, saved, events, requests };
}

it("reports the actual cross-outcome binding failure before persisting claims, without weakening the guard", async () => {
  const data = await researchFixture(), test = harness();
  vi.spyOn(parts, "readCurriculumParts").mockResolvedValue(new Map());
  const persist = vi.spyOn(parts, "persistPartFacts");
  vi.spyOn(parts, "runCurriculumPart").mockImplementation(async (_context, _model, input) => input.commit({} as DbTransaction, {
    rationale: "Synthetic source coverage", claims: [{ ref: feedback.claimRef, text: data.claim.text, outcomeIds: [ids.outcomeA], scope: data.claim.scope,
      support: "direct", unresolvedConflicts: [], passages: [{ sourceId: data.source.id, blockId: "b1", quote: data.source.blocks[0]!.text }] }],
    outcomeEvidence: data.draft.outcomes.map(outcome => ({ outcomeId: outcome.id, claimRefs: [feedback.claimRef], rationale: "Bound source claim" })),
    moduleEstimates: data.draft.modules.map(section => ({ moduleId: section.id, minMinutes: 20, maxMinutes: 80, assumptions: ["Synthetic estimate"] })), limitations: [],
  } as never, { stepId: ids.task }));
  await expect(composer.composeDurableCurriculum(test.context, test.model, { invocationId: ids.task, capturedDraft: data.draft, now,
    sources: [{ document: data.source, blockIds: ["b1"] }], decision: { tool: "revise_curriculum", input: { draftId: data.draft.id,
      expectedRevision: data.draft.revision, changes: [], sources: [{ sourceId: data.source.id, blockIds: ["b1"] }] } } })).rejects.toMatchObject({ code: "invalid_output", feedback });
  expect(persist).not.toHaveBeenCalled();
});

it("retains bounded feedback through rejected-part replay while preserving legacy paid request identity", async () => {
  const test = harness(), schema = z.object({ value: z.string() }).strict(), request = { scope: "unchanged synthetic request" }, instructions = "Unchanged research instructions.";
  const input = { invocationId: ids.request, phase: "research", index: 0, request, instructions, outputSchema: schema,
    resultSchema: schema, saved: test.saved, completedSummary: "Checked research", commit: async () => { throw new CurriculumValidationFailure(feedback); } };
  await expect(parts.runCurriculumPart(test.context, test.model, input)).rejects.toMatchObject({ feedback });
  const key = parts.curriculumPartKey(ids.request, "research", 0), receipt = test.saved.get(key)!;
  expect(receipt.result_reference).toEqual({ partRejected: true, validationFeedback: feedback });
  expect(receipt.input_digest).toBe(jsonDigest({ invocationId: ids.request, request, instructionsDigest: jsonDigest(instructions) }));
  expect(receipt.schema_digest).toBe(jsonDigest(z.toJSONSchema(schema), 65536));
  expect(receipt.capability_digest).toBe(jsonDigest({ model: MODEL_ID, policy: MODEL_POLICY_VERSION, parts: "curriculum-parts-v2" }));
  expect(receipt.validation_policy_digest).toBe(jsonDigest({ version: "curriculum-parts-v2" }));
  expect(test.requests[0]).toMatchObject({ instructionVersion: "curriculum-parts-v2", schemaId: "curriculum_research", schemaVersion: 2,
    trustedInstructions: `${researchInstructions}\n${instructions}`, untrustedInput: request, maxOutputTokens: 16384, model: MODEL_ID });
  expect(test.requests[0]!.schema).toBe(schema);
  await expect(parts.runCurriculumPart(test.context, test.model, input)).rejects.toMatchObject({ feedback });
  expect(test.requests).toHaveLength(1);
  expect(JSON.stringify(test.events)).not.toContain(feedback.claimRef);
  // Historical receipts remain byte-identical and fail generically; no retrospective diagnosis is invented.
  receipt.result_reference = { partRejected: true };
  const before = JSON.stringify(receipt);
  const legacy = await parts.runCurriculumPart(test.context, test.model, input).catch(error => error);
  expect(legacy).toBeInstanceOf(ProviderFailure);
  expect(legacy).not.toBeInstanceOf(CurriculumValidationFailure);
  expect(JSON.stringify(receipt)).toBe(before);
  expect(test.requests).toHaveLength(1);
});

it("sends typed feedback to the planner observation while public failure events stay generic", async () => {
  const data = await researchFixture(), test = harness();
  vi.spyOn(repository, "loadToolAuthority").mockResolvedValue({ ...target, artifactIds: new Set([ids.course]), sourceIds: new Set([ids.source]) });
  vi.spyOn(PostgresResearchRepository.prototype, "getSources").mockResolvedValue([data.source]);
  vi.spyOn(composer, "composeDurableCurriculum").mockRejectedValue(new CurriculumValidationFailure(feedback));
  vi.spyOn(instructionPolicy, "resolveCurriculumInstructionPolicy").mockResolvedValue("legacy-v2");
  const snapshot = repository.ContextSnapshotSchema.parse({ kind: "context", index: 0, now, currentMessage: "Revise the saved course.",
    recentMessages: [], artifacts: [], sources: [], recentTools: [], languageIntent: null });
  const result = await executeAgentTool(test.context, { kind: "decision", index: 0, invocationId: ids.task, capturedDraft: data.draft,
    capturedCourseRevision: 1, preparationError: null, decision: { tool: "revise_curriculum", input: { draftId: ids.draft, expectedRevision: 1,
      changes: [], sources: [{ sourceId: ids.source, blockIds: ["b1"] }] } } }, snapshot,
  { model: test.model, researchForStep: () => { throw new Error("No external research"); } });
  expect(result).toMatchObject({ ok: false, data: { code: "invalid_output", validationFeedback: feedback } });
  expect(JSON.stringify(test.events)).not.toContain(feedback.claimRef);
  expect(JSON.stringify(test.events)).not.toContain("validationFeedback");
  expect(test.requests).toHaveLength(0);
});

it("rejects arbitrary diagnostic bodies and keeps generic failures free of extra fields", async () => {
  expect(CurriculumValidationFeedbackSchema.safeParse({ ...feedback, providerBody: "private" }).success).toBe(false);
  expect(CurriculumValidationFeedbackSchema.safeParse({ ...feedback, claimRef: "x".repeat(81) }).success).toBe(false);
  const test = harness(), schema = z.object({ value: z.string() }).strict();
  await expect(parts.runCurriculumPart(test.context, test.model, { invocationId: ids.request, phase: "research", index: 0,
    request: {}, instructions: "Research", outputSchema: schema, resultSchema: schema, saved: test.saved, completedSummary: "Checked",
    commit: async () => { throw new ProviderFailure("invalid_output"); } })).rejects.toThrow("provider.invalid_output");
  expect([...test.saved.values()][0]!.result_reference).toEqual({ partRejected: true });
});
