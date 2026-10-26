import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { JsonValue } from "@/domain/common";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { DbTransaction } from "@/server/db";
import type { ModelPort, StructuredRequest } from "@/server/ai/ports";
import type { DurableStep, RunContext, StepEffectContext } from "@/server/runs/ports";
import { stableExecutionId } from "@/server/runs/identity";
import { jsonDigest } from "@/server/ai/json";
import { candidatePolicy, CANDIDATE_MODEL_POLICY } from "@/server/ai/model-policy";
import { PostgresResearchRepository } from "@/server/research/repository";
import { PostgresCurriculumResearchRepository } from "@/server/curriculum-research/repository";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { advanceModuleResearch } from "@/server/course-generation/research-stages";
import { approvedKnowledgeKey, prepareApprovedResearchCheckpoint, ApprovedResearchCheckpointSchema } from "@/server/course-generation/approved-research";
import { approvedResearchFactsDigest } from "@/server/course-generation/batch-provenance";
import { ApprovedKnowledgeProposalSchema, ModuleKnowledgeCheckpointSchema, COURSE_GENERATION_SCHEMA_DIGEST,
  COURSE_VALIDATION_POLICY_DIGEST, COURSE_GENERATION_V2_SCHEMA_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { fixture, id, digest } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
function approvedFixture() {
  const data = fixture(2);
  const section = data.draft.modules[0]!;
  section.outcomeIds = data.draft.outcomes.map(outcome => outcome.id);
  const knowledge = { ...data.knowledge[0]!, outcomes: data.knowledge.flatMap(known => known.outcomes) };
  const binding = { run: { id: id(800), phase: "module_research" }, course: { id: data.draft.courseId, ownerId: data.context.ownerId },
    approval: { id: id(801), draftRevision: 1, contentDigest: digest }, draft: data.draft,
    evidence: { limitations: ["Synthetic contract facts, not a generated course."] }, facts: data.context } as unknown as ApprovedBuildBinding;
  return { data, binding, knowledge, moduleId: section.id };
}

// Synthetic in-memory receipts exercise the real proposal, stage and repository boundaries.
// No database, provider, source fetch or capability gate is contacted.
function harness(proposals: unknown[], batchingV2 = true) {
  const fixture = approvedFixture(), { binding, moduleId } = fixture;
  const index = new Map<string, string>();
  const records = new Map<string, { inputDigest: string; result: unknown; schema: string; validationPolicy: string }>();
  const providers = new Map<string, { stepId: string; data: unknown }>();
  const calls: StructuredRequest<unknown>[] = [];
  const rateCard = { policyVersion: CANDIDATE_MODEL_POLICY, model: candidatePolicy.model, provider: candidatePolicy.provider };
  const rateCardDigest = jsonDigest(rateCard), capability = getCapabilityCatalogDigest();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const provider = providers.get(String(params[0])), stored = records.get(String(params[0]));
    let row: unknown;
    if (sql.startsWith("SELECT model_id,provider_tag")) {
      if (provider && provider.stepId === params[1]) row = { model_id: candidatePolicy.model, provider_tag: candidatePolicy.provider, rate_card: rateCard, rate_card_digest: rateCardDigest };
    } else if (sql.includes("FROM unfurl.ai_provider_operations o JOIN")) {
      if (provider && provider.stepId === params[1] && records.get(provider.stepId)?.inputDigest === params[2]) row = {
        operation_id: params[0], run_step_id: provider.stepId, input_digest: params[2], request_digest: digest,
        response_digest: digest, provider_request_id: "synthetic-approved-research", rate_card_digest: rateCardDigest, state: "settled", usage: {},
        result: { model: candidatePolicy.model, provider: candidatePolicy.providerName, failure: null, finishReason: "stop", content: JSON.stringify(provider.data) } };
    } else if (stored) row = { id: params[0], input_digest: stored.inputDigest, result_reference: stored.result,
      schema_digest: stored.schema, validation_policy_digest: stored.validationPolicy, capability_digest: capability, approval_digest: digest,
      generation_policy: batchingV2 ? { result: { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: digest },
        schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, capability, approval: digest } : null };
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  const tx = { query } as unknown as DbTransaction;
  const claimRead = vi.spyOn(PostgresCurriculumResearchRepository.prototype, "getClaim").mockImplementation(async (_tx, ownerId, claimId) =>
    binding.facts.claims.find(claim => claim.ownerId === ownerId && claim.id === claimId) ?? null);
  const passageRead = vi.spyOn(PostgresResearchRepository.prototype, "getPassages").mockImplementation(async (_tx, ids) =>
    binding.facts.passages.filter(passage => ids.includes(passage.id)));
  const model = { generateStructured: vi.fn(async (request: StructuredRequest<unknown>) => {
    calls.push(request);
    const data = request.schema.parse(proposals.shift());
    providers.set(request.budget.reservationId, { stepId: request.budget.runStepId!, data: structuredClone(data) });
    return { data };
  }) } as unknown as ModelPort;
  const context = { claim: { jobId: id(802) }, signal: new AbortController().signal,
    read: async <T>(work: (tx: DbTransaction) => Promise<T>) => work(tx),
    async step<I extends JsonValue, O extends JsonValue, R extends JsonValue>(spec: DurableStep<I, O, R>) {
      const previous = index.get(spec.key);
      if (previous) return spec.resultSchema.parse(records.get(previous)!.result);
      const stepId = stableExecutionId(id(802), spec.key);
      const effect = { stepId, signal: new AbortController().signal, deadlineAt: Date.now() + 60000,
        budgetOperation: (name: string) => { const logicalOperationId = stableExecutionId(stepId, name); return {
          logicalOperationId, reservationId: stableExecutionId(logicalOperationId, "attempt:1"), attempt: 1, runStepId: stepId, probe: false }; } } as StepEffectContext;
      const output = spec.outputSchema.parse(await spec.effect(effect, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      records.set(stepId, { inputDigest: jsonDigest(spec.input), result,
        schema: batchingV2 ? COURSE_GENERATION_V2_SCHEMA_DIGEST : spec.digests.schema,
        validationPolicy: batchingV2 ? COURSE_VALIDATION_V2_POLICY_DIGEST : spec.digests.validationPolicy });
      index.set(spec.key, stepId);
      return result;
    },
  } as unknown as RunContext;
  const research = vi.fn(() => { throw new Error("No external research expected in this contract test"); });
  const advance = () => advanceModuleResearch({ context, binding, index, moduleId, model, research, priorKnowledge: [], batchingV2 });
  return { ...fixture, calls, index, records, providers, advance, research, claimRead, passageRead };
}

describe("approved research reuse", () => {
  it("accepts complete grounded knowledge without fabricating read receipts or weakening the legacy schema", () => {
    const input = approvedFixture();
    const saved = prepareApprovedResearchCheckpoint({ ...input, operationId: id(900), proposal: { status: "sufficient", knowledge: input.knowledge } });
    expect(saved.kind).toBe("course.module.approved_knowledge");
    if (saved.kind !== "course.module.approved_knowledge") throw new Error("Expected grounded proposal");
    expect(saved.sourceReadStepIds).toEqual([]);
    expect(saved.knowledge.outcomes.map(outcome => outcome.outcomeId)).toEqual(input.binding.draft.modules[0]!.outcomeIds);
    expect(saved.approvedFactsDigest).toBe(approvedResearchFactsDigest(input.binding.facts));
    expect(ModuleKnowledgeCheckpointSchema.safeParse({ kind: "course.module.knowledge", knowledge: input.knowledge,
      operationId: id(900), sourceReadStepIds: [] }).success).toBe(false);
  });

  it.each(["uncovered outcome", "unknown claim", "wrong outcome claim", "unknown source", "changed passage", "wrong module", "blocking conflict"])("records a concrete gap for %s despite a sufficient proposal", reason => {
    const input = approvedFixture(), knowledge = structuredClone(input.knowledge);
    if (reason === "uncovered outcome") knowledge.outcomes.pop();
    if (reason === "unknown claim") knowledge.outcomes[0]!.concepts[0]!.claimIds = [id(999)];
    if (reason === "wrong outcome claim") knowledge.outcomes[0]!.concepts[0]!.claimIds = [input.data.claims[1]!.id];
    if (reason === "unknown source") input.binding.facts.authorizedSourceIds = new Set();
    if (reason === "changed passage") input.data.passage.quote = "An invented supporting quote.";
    if (reason === "wrong module") knowledge.moduleId = input.binding.draft.modules[1]!.id;
    if (reason === "blocking conflict") input.data.claims[0]!.unresolvedConflicts = [{ description: "Contradictory source", otherClaimIds: [], blocking: true }];
    const saved = prepareApprovedResearchCheckpoint({ ...input, operationId: id(900), proposal: { status: "sufficient", knowledge } });
    expect(saved.kind).toBe("course.module.approved_knowledge_gap");
    if (saved.kind === "course.module.approved_knowledge_gap") expect(saved.gaps.length).toBeGreaterThan(0);
  });

  it("uses one separately versioned synthesis, then replays verified knowledge without new search or model calls", async () => {
    const expected = approvedFixture();
    const test = harness([{ status: "sufficient", knowledge: expected.knowledge }]);
    expect(await test.advance()).toBeNull();
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]).toMatchObject({ instructionVersion: "course-generation-batch-v2", schemaVersion: 2, maxOutputTokens: 16384 });
    expect(test.calls[0]!.schema).toBe(ApprovedKnowledgeProposalSchema);
    expect(test.calls[0]!.untrustedInput).toMatchObject({ claims: expected.data.claims, passages: [expected.data.passage] });
    const loaded = await test.advance();
    expect(loaded?.knowledge).toEqual(expected.knowledge);
    expect(loaded?.facts.claims).toEqual(expected.data.claims);
    expect((await test.advance())?.knowledge).toEqual(expected.knowledge);
    expect(test.calls).toHaveLength(1);
    expect(test.research).not.toHaveBeenCalled();
  });

  it.each(["declared", "validated"])("persists a %s gap before falling through unchanged legacy research planning", async mode => {
    const expected = approvedFixture(), incomplete = structuredClone(expected.knowledge);
    incomplete.outcomes.pop();
    const plan = { moduleId: expected.moduleId, queries: [{ key: "complete_support", query: "Authoritative support for the complete learner action",
      domainHints: ["example.edu"], outcomeIds: expected.binding.draft.modules[0]!.outcomeIds, knowledgeGap: "Need substantive support for the missing approved outcome." }] };
    const test = harness([mode === "declared" ? { status: "needs_research", gaps: ["Missing substantive support for the second outcome."] }
      : { status: "sufficient", knowledge: incomplete }, plan]);
    await test.advance();
    const saved = ApprovedResearchCheckpointSchema.parse(test.records.get(test.index.get(approvedKnowledgeKey(test.moduleId))!)!.result);
    expect(saved.kind).toBe("course.module.approved_knowledge_gap");
    expect(test.calls).toHaveLength(1);
    expect(await test.advance()).toBeNull();
    expect(test.calls).toHaveLength(2);
    expect(test.index.has(`course/${test.moduleId}/research/plan`)).toBe(true);
    expect(test.calls[1]).toMatchObject({ instructionVersion: "course-generation-v1", schemaVersion: 1, maxOutputTokens: 8192 });
    expect(test.research).not.toHaveBeenCalled();
    // Replaying the saved plan proceeds to its original search stage, not another paid sufficiency/plan call.
    await expect(test.advance()).rejects.toThrow("No external research expected");
    expect(test.calls).toHaveLength(2);
    expect(test.research).toHaveBeenCalledTimes(1);
  });

  it.each(["facts", "stored claim", "paid response"])("rejects %s swaps at replay rather than treating approval IDs as proof", async mutation => {
    const expected = approvedFixture(), test = harness([{ status: "sufficient", knowledge: expected.knowledge }]);
    await test.advance();
    if (mutation === "facts") test.data.claims[0]!.text = "Different claim with the same identity.";
    if (mutation === "stored claim") test.claimRead.mockImplementation(async (_tx, ownerId, claimId) => {
      const original = test.binding.facts.claims.find(claim => claim.ownerId === ownerId && claim.id === claimId);
      return original ? { ...original, text: "Swapped stored claim at the same identity." } : null;
    });
    if (mutation === "paid response") {
      const provider = [...test.providers.values()][0]!;
      provider.data = { status: "needs_research", gaps: ["Actual saved response did not establish sufficiency."] };
    }
    await expect(test.advance()).rejects.toThrow("provider.invalid_output");
    expect(test.calls).toHaveLength(1);
    expect(test.research).not.toHaveBeenCalled();
  });

  it("leaves unmarked legacy advances and saved-plan replay on the old research branch", async () => {
    const expected = approvedFixture();
    const plan = { moduleId: expected.moduleId, queries: [{ key: "legacy", query: "Find primary explanatory support", domainHints: [],
      outcomeIds: expected.binding.draft.modules[0]!.outcomeIds, knowledgeGap: "Investigate the original research plan." }] };
    const test = harness([plan], false);
    await test.advance();
    expect(test.index.has(approvedKnowledgeKey(test.moduleId))).toBe(false);
    expect(test.calls[0]).toMatchObject({ instructionVersion: "course-generation-v1", schemaVersion: 1, maxOutputTokens: 8192 });
    await expect(test.advance()).rejects.toThrow("No external research expected");
    expect(test.calls).toHaveLength(1);
    expect(test.research).toHaveBeenCalledTimes(1);
  });
});
