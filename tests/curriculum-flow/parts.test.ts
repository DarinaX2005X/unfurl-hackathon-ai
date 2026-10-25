import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { composeDurableCurriculum, type DurableCompositionInput } from "../../src/server/curriculum-research/durable-composer";
import * as partRuntime from "../../src/server/curriculum-research/part-runtime";
import { agentToolStepInput, curriculumObservationData } from "../../src/server/agent-tools/executor";
import { projectCurriculumEvidence } from "../../src/server/curriculum-research/validation";
import { jsonDigest } from "../../src/server/ai/json";
import { MODEL_ID } from "../../src/server/ai/constants";
import type { ModelPort, ModelResult, StructuredRequest } from "../../src/server/ai/ports";
import type { JsonValue } from "../../src/domain/common";
import type { ModuleOutline, Outcome } from "../../src/domain/course";
import type { DbTransaction } from "../../src/server/db";
import type { RunContext } from "../../src/server/runs/ports";
import { stableExecutionId } from "../../src/server/runs/identity";
import { artifact, ids, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
class Boundary extends Error {}
function harness(respond: (request: StructuredRequest<unknown>) => unknown) {
  const receipts = new Map<string, partRuntime.SavedCurriculumPart>();
  const calls: StructuredRequest<unknown>[] = [];
  const target = { kind: "agent_turn" as const, runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation, branchId: ids.sample, inputMessageId: ids.missing };
  const tx = { query: async () => ({ rows: Array.from(receipts.values()) }) } as unknown as DbTransaction;
  const model: ModelPort = {
    capabilities: () => ({ model: MODEL_ID, provider: "digitalocean", structured: true, text: true, search: true, rubric: true, limitations: [] }),
    async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
      calls.push(request as StructuredRequest<unknown>);
      const data = request.schema.parse(respond(request as StructuredRequest<unknown>));
      return { data, evidence: { operationId: request.operationId, reservationId: request.budget.reservationId, providerRequestId: "fixture",
        requestedModel: MODEL_ID, returnedModel: MODEL_ID, provider: "digitalocean", finishReason: "stop", rateCardDigest: "a".repeat(64), replayed: false,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: null, cachedPromptTokens: null, searchRequests: 0, costUsd: "0" } } };
    },
    async *streamText() { throw new Error("Not used"); },
  };
  let effects = 0;
  const context: RunContext = {
    claim: { jobId: ids.approval, leaseOwner: "test", fencingToken: "1", retryEpoch: 0, target }, signal: new AbortController().signal,
    read: (work) => work(tx, target),
    async step(spec) {
      if (receipts.has(spec.key)) throw new Error("Saved parts should use the single bounded journal read, not individual replay transactions");
      if (effects++) throw new Boundary();
      expect(spec.executionProfile).toBe("longform_curriculum");
      const stepId = stableExecutionId(ids.approval, spec.key);
      const output = spec.outputSchema.parse(await spec.effect({ stepId, deadlineAt: Date.now() + 270000, signal: context.signal,
        stepFence: { jobId: ids.approval, jobLeaseOwner: "test", jobFencingToken: "1", retryEpoch: 0, stepId, stepLeaseOwner: "test", stepFencingToken: "1" },
        budgetOperation: (name) => ({ logicalOperationId: stableExecutionId(stepId, name), reservationId: stableExecutionId(stepId, `${name}:1`), attempt: 1, runStepId: stepId, probe: false }),
      }, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      receipts.set(spec.key, { step_key: spec.key, input_digest: jsonDigest(spec.input), schema_digest: spec.digests.schema,
        capability_digest: spec.digests.capability, validation_policy_digest: spec.digests.validationPolicy, approval_digest: spec.digests.approval, result_reference: result });
      return result;
    },
    emitChat: async (_tx, payload) => ({ ...payload, id: ids.task, runId: target.runId, branchId: target.branchId, seq: 1, at: now }),
    emitGeneration: async () => { throw new Error("Unexpected generation event"); },
    completeTurn: async () => { throw new Error("Composition does not finish a chat turn"); },
    completeGeneration: async () => { throw new Error("Composition does not finish a build"); },
  };
  async function finish(input: DurableCompositionInput) {
    for (let advances = 0; advances < 100; advances++) {
      effects = 0;
      try { return await composeDurableCurriculum(context, model, input); }
      catch (error) { if (!(error instanceof Boundary)) throw error; }
    }
    throw new Error("Fixture did not finish");
  }
  return { context, model, calls, receipts, finish, resetAdvance: () => { effects = 0; } };
}

async function fixture() {
  const base = await researchFixture();
  const sourceSelection = [{ sourceId: base.source.id, blockIds: ["b1"] }];
  const scope = { sources: [{ document: base.source, blockIds: ["b1"] }], now, capturedDraft: null, invocationId: ids.task };
  const input: DurableCompositionInput = { ...scope, decision: { tool: "create_course", input: {
    goal: base.draft.goal, audience: base.draft.audience, assumedKnowledge: [], contentLanguage: "en",
    requiredCapabilities: ["Compare held-out error", "Assess generalization"], sources: sourceSelection,
  } } };
  const outcomes: Outcome[] = Array.from({ length: 40 }, (_, index) => ({ id: stableExecutionId(ids.course, `outcome:${index}`),
    title: `Outcome ${index}`, demonstration: `Demonstrate this comparison ${index}. ` + "x".repeat(3700),
    prerequisiteOutcomeIds: index ? [stableExecutionId(ids.course, `outcome:${index - 1}`)] : [], requirement: "core" }));
  const modules: ModuleOutline[] = outcomes.map((outcome, index) => ({ id: stableExecutionId(ids.course, `module:${index}`),
    title: `Module ${index}`, summary: `Apply this comparison ${index}. ` + "y".repeat(3700), outcomeIds: [outcome.id],
    prerequisiteModuleIds: index ? [stableExecutionId(ids.course, `module:${index - 1}`)] : [], estimatedStudyMinutes: 45 }));
  const section = (key: string, prerequisiteKeys: string[], requiredCapabilities: string[]) => ({ key, title: key, scope: `Develop ${key} thoroughly.`, prerequisiteKeys, requiredCapabilities, sources: sourceSelection });
  function respond(request: StructuredRequest<unknown>): unknown {
    const payload = request.untrustedInput as Record<string, JsonValue>;
    switch (request.schemaId) {
      case "curriculum_roadmap": return payload.continuation === null
        ? { header: { title: base.draft.title, goal: base.draft.goal, audience: base.draft.audience, assumedKnowledge: ["Prior algebra"], contentLanguage: "en",
          unresolvedQuestions: [], summary: "A synthetic large assembly fixture", rationale: base.evidence.rationale, limitations: [] },
          sections: [section("comparison", [], ["Compare held-out error"])], complete: false, nextFocus: "Plan generalization next" }
        : { header: null, sections: [section("generalization", ["comparison"], ["Assess generalization"])], complete: true, nextFocus: null };
      case "curriculum_outline": {
        const sectionData = payload.section as { key: string };
        const offset = payload.continuation === null ? 0 : Number(String(payload.continuation).split(":")[1]);
        const from = (sectionData.key === "comparison" ? 0 : 20) + offset;
        return { outcomes: outcomes.slice(from, from + 4), modules: modules.slice(from, from + 4), complete: offset === 16,
          nextFocus: offset === 16 ? null : `offset:${offset + 4}` };
      }
      case "curriculum_research": {
        const selected = payload.outcomes as unknown as Outcome[], outlines = payload.modules as unknown as ModuleOutline[];
        return { rationale: `Research rationale in ${payload.contentLanguage}`, limitations: [],
          claims: selected.map((outcome, index) => ({ ref: `claim_${index}`, text: base.claim.text, outcomeIds: [outcome.id], scope: base.claim.scope,
            support: "direct", passages: [{ sourceId: base.source.id, blockId: "b1", quote: base.passage.quote }], unresolvedConflicts: [] })),
          outcomeEvidence: selected.map((outcome, index) => ({ outcomeId: outcome.id, claimRefs: [`claim_${index}`], rationale: "The actual quote supports this fixture outcome." })),
          moduleEstimates: outlines.map((outline) => ({ moduleId: outline.id, minMinutes: 20, maxMinutes: 80, assumptions: ["Practice and reflection are included."] })) };
      }
      case "curriculum_translate_header": return { title: `RU ${payload.title}`, goal: `RU ${payload.goal}`, audience: `RU ${payload.audience}` };
      case "curriculum_translate_outcomes": return { entries: (payload.entries as unknown as Outcome[]).map(({ id, title, demonstration }) => ({ id, title: `RU ${title}`, demonstration: `RU ${demonstration}` })) };
      case "curriculum_translate_modules": return { entries: (payload.entries as unknown as ModuleOutline[]).map(({ id, title, summary }) => ({ id, title: `RU ${title}`, summary: `RU ${summary}` })) };
      case "curriculum_translate_assumptions": return { entries: (payload.entries as unknown as Array<{ index: number; text: string }>).map((entry) => ({ ...entry, text: `RU ${entry.text}` })) };
      default: throw new Error(`Unexpected fixture part ${request.schemaId}`);
    }
  }
  return { base, input, outcomes, modules, respond };
}

it("assembles a >256 KiB programme across saved continuations without reissuing paid parts or growing planner inputs", async () => {
  vi.spyOn(partRuntime, "persistPartFacts").mockImplementation(async (_tx, input) => ({ claims: input.claims, passages: input.passages }));
  const data = await fixture(), test = harness(data.respond);
  const result = await test.finish(data.input);
  expect(Buffer.byteLength(JSON.stringify(result.draft))).toBeGreaterThan(256 * 1024);
  expect(result.draft.outcomes).toEqual(data.outcomes);
  expect(result.draft.modules).toEqual(data.modules);
  expect(result.evidence.outcomeEvidence).toHaveLength(40);
  expect(result.evidence.moduleEstimates).toHaveLength(40);
  expect(result.facts.claims).toHaveLength(40);
  expect(test.calls).toHaveLength(22);
  expect(new Set(test.calls.map((call) => call.operationId)).size).toBe(test.calls.length);
  expect(test.calls.every((call) => call.maxOutputTokens === 16384 && call.executionProfile === "longform_curriculum")).toBe(true);
  expect(Math.max(...test.calls.map((call) => Buffer.byteLength(JSON.stringify(call.untrustedInput))))).toBeLessThan(80000);
  test.resetAdvance();
  expect((await composeDurableCurriculum(test.context, test.model, data.input)).draft).toEqual(result.draft);
  expect(test.calls).toHaveLength(22);
  const reference = { ...artifact(), courseId: result.draft.courseId, title: result.draft.title, curriculum: result.draft };
  const snapshot = { draft: result.draft, contentDigest: result.evidence.contentDigest, artifact: reference,
    evidence: projectCurriculumEvidence(result.draft, result.evidence, result.facts, []), generationRun: null, authoringRun: null, languageRun: null };
  expect(Buffer.byteLength(JSON.stringify(curriculumObservationData(snapshot)))).toBeLessThan(12000);
  expect(curriculumObservationData(snapshot, { kind: "modules", offset: 12, limit: 3 }).page?.items).toEqual(result.draft.modules.slice(12, 15));
  expect(Buffer.byteLength(JSON.stringify(agentToolStepInput({ kind: "decision", index: 0, invocationId: ids.task,
    decision: { tool: "read_artifact", input: { courseId: result.draft.courseId } }, capturedDraft: result.draft, capturedCourseRevision: 1, preparationError: null })))).toBeLessThan(1000);
});

it("translates and revises a large programme in scoped batches while retaining every identity and typed edit", async () => {
  vi.spyOn(partRuntime, "persistPartFacts").mockImplementation(async (_tx, input) => ({ claims: input.claims, passages: input.passages }));
  const data = await fixture();
  const current = { ...data.base.draft, outcomes: data.outcomes, modules: data.modules, assumedKnowledge: ["Prior algebra"] };
  const sourceSelection = [{ sourceId: data.base.source.id, blockIds: ["b1"] }];
  const translation = harness(data.respond);
  const translated = await translation.finish({ ...data.input, invocationId: ids.sample, capturedDraft: current,
    decision: { tool: "revise_language", input: { courseId: current.courseId, expectedRevision: 1, expectedDraftRevision: current.revision, contentLanguage: "ru", sources: sourceSelection } } });
  expect(translated.draft.contentLanguage).toBe("ru");
  expect(translated.draft.outcomes.map(({ id, prerequisiteOutcomeIds, requirement }) => ({ id, prerequisiteOutcomeIds, requirement })))
    .toEqual(current.outcomes.map(({ id, prerequisiteOutcomeIds, requirement }) => ({ id, prerequisiteOutcomeIds, requirement })));
  expect(translated.draft.modules.map(({ id, outcomeIds, prerequisiteModuleIds }) => ({ id, outcomeIds, prerequisiteModuleIds })))
    .toEqual(current.modules.map(({ id, outcomeIds, prerequisiteModuleIds }) => ({ id, outcomeIds, prerequisiteModuleIds })));
  expect(translated.evidence.rationale).toBe("Research rationale in ru");
  expect(translation.calls.filter((call) => call.schemaId === "curriculum_translate_outcomes")).toHaveLength(10);
  expect(translation.calls.every((call) => Buffer.byteLength(JSON.stringify(call.untrustedInput)) < 80000)).toBe(true);
  const revision = harness(data.respond);
  const revised = await revision.finish({ ...data.input, invocationId: ids.missing, capturedDraft: current,
    decision: { tool: "revise_curriculum", input: { draftId: current.id, expectedRevision: current.revision,
      changes: [{ op: "set_details", title: "Exactly the user's revised title" }], sources: sourceSelection } } });
  expect(revised.draft.title).toBe("Exactly the user's revised title");
  expect(revised.draft.outcomes).toEqual(current.outcomes);
  expect(revised.draft.modules).toEqual(current.modules);
  expect(revision.calls).toHaveLength(10);
  expect(revision.calls.every((call) => !Object.hasOwn(call.untrustedInput as object, "current"))).toBe(true);
});

it("records a rejected part once instead of repeating its model call during recovery", async () => {
  const data = await fixture();
  const test = harness(() => ({ wrong: "schema" }));
  await expect(test.finish(data.input)).rejects.toMatchObject({ code: "invalid_output" });
  test.resetAdvance();
  await expect(composeDurableCurriculum(test.context, test.model, data.input)).rejects.toMatchObject({ code: "invalid_output" });
  expect(test.calls).toHaveLength(1);
  expect(test.receipts.size).toBe(1);
});
