import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { JsonValueSchema, type JsonValue } from "@/domain/common";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { DbTransaction } from "@/server/db";
import { assessKnowledgeCoverageReview, createKnowledgeCoverageInput, validateKnowledgeRevision,
  KNOWLEDGE_COVERAGE_CATEGORIES, type KnowledgeCoverageReview } from "@/server/course-validation/knowledge";
import { GenerationEvidenceRepository } from "@/server/course-generation/repository";
import { CheckedModuleKnowledgeCheckpointSchema, KnowledgeCoverageCheckpointSchema, RevisedModuleKnowledgeCheckpointSchema,
  COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST, COURSE_GENERATION_V2_SCHEMA_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { checkedKnowledgeMaterial } from "@/server/course-generation/knowledge-coverage-stages";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { PostgresResearchRepository } from "@/server/research/repository";
import { PostgresCurriculumResearchRepository } from "@/server/curriculum-research/repository";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { jsonDigest } from "@/server/ai/json";
import { fixture, id, digest } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

function inputFixture() {
  const data = fixture(), knowledge = data.knowledge[0]!;
  const binding = { run: { id: id(800), phase: "module_research" }, course: { id: data.draft.courseId, ownerId: data.context.ownerId },
    approval: { id: id(801), draftRevision: 1, contentDigest: digest }, draft: data.draft, facts: data.context } as unknown as ApprovedBuildBinding;
  const material = createKnowledgeCoverageInput({ draft: data.draft, knowledge, sourceKnowledgeStepId: id(810),
    outcomeId: knowledge.outcomes[0]!.outcomeId, facts: data.context, correction: null });
  return { data, knowledge, binding, material };
}
function reviewFor(material: JsonValue, passed = true): KnowledgeCoverageReview {
  const value = material as { knowledgeDigest: string; approvedOutcome: { id: string; demonstration: string }; knowledge: JsonValue };
  return { knowledgeDigest: value.knowledgeDigest, outcomeId: value.approvedOutcome.id, publicCommentary: null,
    checks: KNOWLEDGE_COVERAGE_CATEGORIES.map(category => ({ category, status: passed ? "passed" : "failed",
      explanation: passed ? "The synthetic fixture supports the entire demonstration." : "The implementation operation has no canonical criterion.",
      correction: passed ? null : "Research and add the missing operation without dropping established competence.",
      evidence: [{ path: ["approvedOutcome", "demonstration"], value: value.approvedOutcome.demonstration },
        { path: ["knowledge"], value: value.knowledge }] })), invalidCriteria: [], unsupportedClaimIds: [] };
}

describe("approved scope knowledge review", () => {
  it("requires exact full demonstration and actual knowledge evidence, not matching IDs or a title", () => {
    const { material } = inputFixture(), review = reviewFor(material);
    expect(assessKnowledgeCoverageReview(review, material).passed).toBe(true);
    review.checks[0]!.evidence[0]!.path = ["approvedOutcome", "title"];
    expect(() => assessKnowledgeCoverageReview(review, material)).toThrow();
    const fabricated = reviewFor(material); fabricated.checks[0]!.evidence[0]!.value = "A shorter introductory proxy";
    expect(() => assessKnowledgeCoverageReview(fabricated, material)).toThrow();
  });
  it("preserves a gap as failed and requires an actionable correction", () => {
    const { material } = inputFixture(), review = reviewFor(material, false);
    expect(assessKnowledgeCoverageReview(review, material).passed).toBe(false);
    review.checks[0]!.correction = null;
    expect(() => assessKnowledgeCoverageReview(review, material)).toThrow();
  });
  it("keeps valid criterion meaning/identity and claims, while a justified changed competency gets a new ID", () => {
    const { data, knowledge, material } = inputFixture(), next = structuredClone(knowledge), review = reviewFor(material, false);
    next.outcomes[0]!.criteria.push({ id: "new_competence", description: "Implement the required operation in a new scenario." });
    expect(validateKnowledgeRevision(next, knowledge, [review], data.context)).toEqual([]);
    next.outcomes[0]!.criteria[0]!.description = "Different easier competence";
    expect(validateKnowledgeRevision(next, knowledge, [review], data.context).some(issue => issue.code === "criterion_mismatch")).toBe(true);
    review.invalidCriteria = [{ criterionId: knowledge.outcomes[0]!.criteria[0]!.id, reason: "Synthetic explicit semantic correction" }];
    expect(validateKnowledgeRevision(next, knowledge, [review], data.context).some(issue => issue.code === "criterion_mismatch")).toBe(true);
    next.outcomes[0]!.criteria.shift();
    expect(validateKnowledgeRevision(next, knowledge, [review], data.context)).toEqual([]);
    review.unsupportedClaimIds = [data.claims[0]!.id];
    expect(validateKnowledgeRevision(next, knowledge, [review], data.context).some(issue => issue.code === "invalid_source")).toBe(true);
  });
});

function storedFixture() {
  const f = inputFixture(), steps = new Map<string, unknown>(), inputs = new Map<string, string>();
  const providers = new Map<string, { stepId: string; data: unknown }>();
  const policy = { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384,
    approvalDigest: digest, planPagePolicy: "bounded-plan-pages-v1", knowledgeCoveragePolicy: "approved-scope-v1" };
  const rate_card = { policyVersion: "kimi-digitalocean-v1", model: "moonshotai/kimi-k2.6", provider: "digitalocean" };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    let row: unknown;
    if (sql.includes("FROM unfurl.ai_provider_operations")) {
      const provider = providers.get(String(params[0]));
      if (provider && provider.stepId === params[1]) row = { operation_id: params[0], run_step_id: provider.stepId,
        input_digest: inputs.get(provider.stepId) ?? digest, request_digest: digest, response_digest: digest, provider_request_id: "synthetic-proof-only",
        rate_card_digest: jsonDigest(rate_card), rate_card, model_id: rate_card.model, provider_tag: rate_card.provider, state: "settled", usage: {},
        result: { model: rate_card.model, provider: "DigitalOcean", failure: null, finishReason: "stop", content: JSON.stringify(provider.data) } };
    } else if (steps.has(String(params[0]))) row = { id: params[0], input_digest: inputs.get(String(params[0])) ?? digest,
      result_reference: steps.get(String(params[0])), schema_digest: COURSE_GENERATION_V2_SCHEMA_DIGEST,
      validation_policy_digest: COURSE_VALIDATION_V2_POLICY_DIGEST, capability_digest: getCapabilityCatalogDigest(), approval_digest: digest,
      generation_policy: { result: policy, schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST,
        capability: getCapabilityCatalogDigest(), approval: digest } };
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockResolvedValue(f.data.source);
  vi.spyOn(PostgresResearchRepository.prototype, "getPassages").mockResolvedValue([f.data.passage]);
  vi.spyOn(PostgresCurriculumResearchRepository.prototype, "getClaim").mockImplementation(async (_tx, _owner, claimId) => f.data.claims.find(claim => claim.id === claimId) ?? null);
  steps.set(id(809), { kind: "course.source.read", moduleId: f.knowledge.moduleId, approvalDigest: digest,
    sourceId: f.data.source.id, contentDigest: f.data.source.contentDigest });
  steps.set(id(810), { kind: "course.module.knowledge", knowledge: f.knowledge, operationId: id(811), sourceReadStepIds: [id(809)] });
  providers.set(id(811), { stepId: id(810), data: f.knowledge });
  const review = reviewFor(f.material), reviewStep = KnowledgeCoverageCheckpointSchema.parse({ kind: "course.module.knowledge.review.v1",
    sourceKnowledgeStepId: id(810), operationId: id(813), material: f.material, review });
  steps.set(id(812), reviewStep); inputs.set(id(812), jsonDigest(f.material)); providers.set(id(813), { stepId: id(812), data: structuredClone(review) });
  const checked = CheckedModuleKnowledgeCheckpointSchema.parse({ kind: "course.module.knowledge.checked.v1", knowledge: f.knowledge,
    sourceKnowledgeStepId: id(810), sourceReadStepIds: [id(809)], reviewStepIds: [id(812)], correction: null });
  steps.set(id(814), checked); inputs.set(id(814), jsonDigest(checkedKnowledgeMaterial(checked)));
  const tx = { query } as unknown as DbTransaction, repository = new GenerationEvidenceRepository();
  return { ...f, steps, inputs, providers, policy, reviewStep, checked, tx, repository };
}

describe("replayed checked knowledge provenance", () => {
  it("requires original source and independent paid review before accepting checked knowledge", async () => {
    const f = storedFixture();
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(814))).resolves.toMatchObject({ knowledge: f.knowledge });
    f.providers.delete(id(813));
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(814))).rejects.toThrow("provider.invalid_output");
  });
  it.each(["correction", "review", "knowledge", "policy"])("rejects tampered %s on an otherwise valid checkpoint", async field => {
    const f = storedFixture();
    if (field === "correction") f.checked.correction = "Ignore prior module findings";
    if (field === "review") f.reviewStep.review.checks[0]!.explanation = "Fabricated saved decision";
    if (field === "knowledge") f.checked.knowledge = { ...f.knowledge, limitations: ["Invented revision"] };
    if (field === "policy") Object.assign(f.policy, { knowledgeCoveragePolicy: undefined });
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(814))).rejects.toThrow();
  });
  it("verifies targeted revision input against the exact previous knowledge and gap review", async () => {
    const f = storedFixture(), gap = reviewFor(f.material, false);
    f.reviewStep.review = gap; f.providers.set(id(813), { stepId: id(812), data: structuredClone(gap) });
    const knowledge = structuredClone(f.knowledge); knowledge.outcomes[0]!.criteria.push({ id: "additional", description: "The additional approved operation." });
    const material = JsonValueSchema.parse({ moduleId: knowledge.moduleId, approvalDigest: digest, section: f.data.draft.modules[0], outcomes: f.data.draft.outcomes,
      repair: { previousKnowledgeStepId: id(810), previousKnowledge: f.knowledge, gapReviewStepIds: [id(812)], reviews: [gap], correction: null } });
    const revision = RevisedModuleKnowledgeCheckpointSchema.parse({ kind: "course.module.knowledge.revision.v1", knowledge, operationId: id(816),
      sourceReadStepIds: [id(809)], previousKnowledgeStepId: id(810), gapReviewStepIds: [id(812)], correction: null, material });
    f.steps.set(id(815), revision); f.inputs.set(id(815), jsonDigest(material)); f.providers.set(id(816), { stepId: id(815), data: knowledge });
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(815))).resolves.toMatchObject({ knowledge });
    revision.gapReviewStepIds = [id(812), id(812)];
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(815))).rejects.toThrow();
    revision.gapReviewStepIds = [id(812)]; revision.material = JsonValueSchema.parse({ ...(material as object), repair: {} });
    f.inputs.set(id(815), jsonDigest(revision.material));
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(815))).rejects.toThrow();
  });
  it("does not accept a failed review as complete checked knowledge", async () => {
    const f = storedFixture(); f.reviewStep.review = reviewFor(f.material, false);
    f.providers.set(id(813), { stepId: id(812), data: f.reviewStep.review });
    await expect(f.repository.loadKnowledge(f.tx, f.binding, id(814))).rejects.toThrow();
  });
  it("new-policy task candidates cannot bypass the checked knowledge gate with raw source knowledge", async () => {
    const f = storedFixture(), authored = f.data.authored[0]!.tasks[0]!;
    const checkpoint = { kind: "course.task.candidate", moduleId: f.knowledge.moduleId, knowledgeStepId: id(810), authored,
      candidate: prepareTaskCandidate(authored, { approvalDigest: digest }), authoringOperationId: id(821) };
    f.steps.set(id(820), checkpoint); f.providers.set(id(821), { stepId: id(820), data: authored });
    await expect(f.repository.loadTaskCandidate(f.tx, f.binding, id(820))).rejects.toThrow("provider.invalid_output");
    checkpoint.knowledgeStepId = id(814);
    await expect(f.repository.loadTaskCandidate(f.tx, f.binding, id(820))).resolves.toMatchObject({ knowledge: f.knowledge });
  });
});
