import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { approvedResearchFactsDigest, assertBatchItemProjection, createBatchItemProof } from "@/server/course-generation/batch-provenance";
import { AuthoredTaskSchema, batchResponseSchema, COURSE_GENERATION_SCHEMA_DIGEST, COURSE_GENERATION_V2_SCHEMA_DIGEST,
  COURSE_VALIDATION_POLICY_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { verifyStoredBatchItem } from "@/server/course-generation/repository";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { jsonDigest } from "@/server/ai/json";
import { modelPolicy } from "@/server/ai/model-policy";
import { digest, fixture, id, preparedFixture } from "./fixtures";

function batchFixture() {
  const data = fixture(), value = data.authored[0]!.tasks[0]!, itemId = value.task.id, moduleId = data.draft.modules[0]!.id;
  const items = [{ itemId, value }], itemMaterial = { slot: { id: itemId, lessonId: data.authored[0]!.lessons[0]!.id,
    outcomeIds: value.task.outcomeIds, mechanicId: value.task.mechanicId, mechanicVersion: value.task.mechanicVersion,
    design: structuredClone(value.design), assessmentRole: value.privateTask.assessment.role,
    criteria: value.privateTask.assessment.outcomes.map(outcome => ({ outcomeId: outcome.outcomeId, criterionIds: outcome.dimensions.map(dimension => dimension.dimensionId) })) },
    knowledge: data.knowledge[0]!, approvalDigest: digest };
  const material = { batchKind: "candidate" as const, moduleId, approvalDigest: digest, requestedIds: [itemId], items: [{ itemId, material: itemMaterial }] };
  const proof = createBatchItemProof(id(700), items, itemId);
  return { data, value, itemId, items, material, proof, childInputDigest: jsonDigest(itemMaterial), batchKind: "candidate" as const,
    expectedKind: "candidate" as const, approvalDigest: digest, expected: value };
}

describe("immutable batch item projections", () => {
  it("rederives a stable item proof without granting any receipt", () => {
    const input = batchFixture();
    expect(createBatchItemProof(id(700), input.items, input.itemId)).toEqual(input.proof);
    expect(assertBatchItemProjection(input).value).toEqual(input.value);
    expect(JSON.stringify(input.proof)).not.toContain("verdict");
  });
  it.each(["digest", "index", "item", "input", "role", "approval", "order", "value"])("rejects tampered %s", (change) => {
    const input = batchFixture();
    if (change === "digest") input.proof.itemDigest = "f".repeat(64);
    if (change === "index") input.proof.itemIndex = 1;
    if (change === "item") input.proof.itemId = id(999);
    if (change === "input") input.childInputDigest = "f".repeat(64);
    if (change === "role") Object.assign(input, { expectedKind: "review" });
    if (change === "approval") input.approvalDigest = "f".repeat(64);
    if (change === "order") input.material.requestedIds = [id(999)];
    if (change === "value") input.expected = { ...input.value, task: { ...input.value.task, instruction: "Different" } };
    expect(() => assertBatchItemProjection(input)).toThrow("provider.invalid_output");
  });
  it("rejects duplicate, missing and oversized batch responses", () => {
    const input = batchFixture(), schema = batchResponseSchema(AuthoredTaskSchema);
    expect(() => schema.parse({ items: [...input.items, ...input.items] })).toThrow();
    expect(() => schema.parse({ items: [] })).toThrow();
    expect(() => schema.parse({ items: Array.from({ length: 6 }, (_, i) => ({ itemId: id(900 + i), value: input.value })) })).toThrow();
  });
  it.each(["incomplete", "mechanic", "version", "outcomes", "design", "role", "criteria"])("rederives immutable planned slot %s at replay", (change) => {
    const input = batchFixture(), context = input.material.items[0]!.material;
    if (change === "incomplete") Object.assign(context, { slot: { id: input.itemId } });
    if (change === "mechanic") context.slot.mechanicId = "example_construction";
    if (change === "version") context.slot.mechanicVersion = 1;
    if (change === "outcomes") context.slot.outcomeIds = [id(999)];
    if (change === "design") context.slot.design.learnerAction = "A different action";
    if (change === "role") context.slot.assessmentRole = "challenge";
    if (change === "criteria") context.slot.criteria[0]!.criterionIds = ["other_criterion"];
    input.childInputDigest = jsonDigest(context);
    expect(() => assertBatchItemProjection(input)).toThrow();
  });
  it("binds all canonical approved facts, including same-ID text and passage mutations", () => {
    const facts = fixture().context, original = approvedResearchFactsDigest(facts);
    expect(approvedResearchFactsDigest({ ...facts, claims: [...facts.claims].reverse() })).toBe(original);
    const changed = structuredClone(facts); changed.claims[0]!.text += " changed";
    expect(approvedResearchFactsDigest(changed)).not.toBe(original);
    const changedPassage = structuredClone(facts); changedPassage.passages[0]!.quote += " changed";
    expect(approvedResearchFactsDigest(changedPassage)).not.toBe(original);
  });
});

function storedBatchFixture(kind: "candidate" | "cases" = "candidate") {
  const input = batchFixture(), data = preparedFixture(), candidate = data.modules[0]!.tasks[0]!.candidate;
  const policy = modelPolicy("gemini-flash-google-schema-v2"), rate_card = { model: policy.model, provider: policy.provider, policyVersion: policy.id };
  const operationId = id(701), candidateStepId = id(704);
  const material = kind === "candidate" ? input.material : { ...input.material, batchKind: kind,
    items: [{ ...input.material.items[0]!, candidateStepId, candidateDigest: candidate.candidateDigest }] };
  const parent = { id: input.proof.batchStepId, input_digest: jsonDigest(material),
    schema_digest: COURSE_GENERATION_V2_SCHEMA_DIGEST, validation_policy_digest: COURSE_VALIDATION_V2_POLICY_DIGEST,
    capability_digest: getCapabilityCatalogDigest(), approval_digest: digest,
    generation_policy: { result: { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: digest },
      schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, capability: getCapabilityCatalogDigest(), approval: digest },
    result_reference: { kind: "course.model.batch.v2", batchKind: kind, operationId, material, items: input.items } };
  const candidateRow = { ...parent, id: candidateStepId, result_reference: { kind: "course.task.candidate", moduleId: data.draft.modules[0]!.id,
    knowledgeStepId: id(705), authored: input.value, candidate, authoringOperationId: id(706) } };
  const knowledgeRow = { ...parent, id: id(705), result_reference: { kind: "course.module.knowledge", knowledge: data.knowledge[0]!, operationId: id(707), sourceReadStepIds: [id(708)] } };
  const provider = { operation_id: operationId, run_step_id: parent.id, input_digest: parent.input_digest,
    request_digest: "b".repeat(64), response_digest: "c".repeat(64), provider_request_id: "synthetic-contract-only", state: "settled", usage: {},
    rate_card_digest: jsonDigest(rate_card), model_id: policy.model, provider_tag: policy.provider, rate_card,
    result: { model: policy.model, provider: policy.providerName, failure: null, finishReason: "stop", content: JSON.stringify({ items: input.items }) } };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes("WITH RECURSIVE lineage")) return { rows: [values[0] === candidateStepId ? candidateRow : values[0] === knowledgeRow.id ? knowledgeRow : parent] };
    return { rows: [provider] };
  });
  const tx = { query } as unknown as DbTransaction;
  const binding = { run: { id: id(800) }, course: { id: data.draft.courseId, ownerId: id(6) },
    approval: { id: id(801), draftRevision: 1, contentDigest: digest }, draft: data.draft } as ApprovedBuildBinding;
  const child = { id: id(702), inputDigest: input.childInputDigest, result: kind === "candidate" ? { moduleId: data.draft.modules[0]!.id, knowledgeStepId: knowledgeRow.id } : { candidateStepId, candidateDigest: candidate.candidateDigest } };
  return { input, tx, binding, child, operationId, parent, provider, candidateRow, knowledgeRow, query };
}

describe("paid parent batch evidence", () => {
  it("verifies the original paid parent before deriving a child and replays without a paid request", async () => {
    const x = storedBatchFixture();
    for (let replay = 0; replay < 2; replay++) await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "candidate")).resolves.toBe("google/gemini-3.8-flash");
    const evidenceQueries = x.query.mock.calls.filter(([sql]) => sql.includes("JOIN unfurl.ai_provider_responses"));
    expect(evidenceQueries).toHaveLength(2);
    expect(evidenceQueries.every(([, values]) => values[1] === x.parent.id)).toBe(true);
  });
  it("rejects a checkpoint item that differs from the saved paid response", async () => {
    const x = storedBatchFixture(); x.parent.result_reference.items[0]!.value.task.instruction = "Tampered after payment";
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "candidate")).rejects.toThrow("provider.invalid_output");
  });
  it("rejects a supported response model that differs from the paid operation profile", async () => {
    const x = storedBatchFixture(); x.provider.result.model = "moonshotai/kimi-k2.6";
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "candidate")).rejects.toThrow("provider.invalid_output");
  });
  it("rejects using the author operation as independent adversarial evidence", async () => {
    const x = storedBatchFixture("cases"); x.candidateRow.result_reference.authoringOperationId = x.operationId;
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "cases")).rejects.toThrow("provider.invalid_output");
  });
  it("rejects a batch item bound to a different candidate", async () => {
    const x = storedBatchFixture("cases"); Object.assign(x.child.result, { candidateDigest: "f".repeat(64) });
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "cases")).rejects.toThrow("provider.invalid_output");
  });
  it("rejects a candidate child moved to another approved module", async () => {
    const x = storedBatchFixture(); Object.assign(x.child.result, { moduleId: id(999) });
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "candidate")).rejects.toThrow("provider.invalid_output");
  });
  it("rejects another same-module knowledge checkpoint than the paid author saw", async () => {
    const x = storedBatchFixture(); x.knowledgeRow.result_reference.knowledge.outcomes[0]!.learnerAction += " changed";
    await expect(verifyStoredBatchItem(x.tx, x.binding, x.child, x.operationId, x.input.proof, AuthoredTaskSchema, x.input.value, "candidate")).rejects.toThrow("provider.invalid_output");
  });
});
