import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { loadGenerationStep, verifyStoredModelData, verifyStoredModelDataAndIdentity, resolveGenerationPolicy } from "@/server/course-generation/repository";
import { COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { id, digest } from "./fixtures";
import { jsonDigest } from "@/server/ai/json";
import { modelPolicy, type ModelPolicyId } from "@/server/ai/model-policy";
import { COURSE_GENERATION_V2_SCHEMA_DIGEST, COURSE_VALIDATION_V2_POLICY_DIGEST, COURSE_GENERATION_POLICY_KEY } from "@/server/course-generation/checkpoints";

function providerRow(policyId: ModelPolicyId = "kimi-digitalocean-v1") {
  const policy = modelPolicy(policyId), rate_card = { model: policy.model, provider: policy.provider, policyVersion: policy.id };
  return { operation_id: id(802), run_step_id: id(801), input_digest: "b".repeat(64), request_digest: "c".repeat(64), response_digest: "d".repeat(64),
    provider_request_id: "mock-contract-only", rate_card_digest: jsonDigest(rate_card), state: "settled", usage: {}, rate_card,
    model_id: policy.model, provider_tag: policy.provider,
    result: { model: policy.model, provider: policy.providerName, failure: null, finishReason: "stop", content: JSON.stringify({ answer: "actual" }) } };
}

// Mock rows establish rejection logic only; they are not stored or paid provider evidence.
function txFor(row: unknown): DbTransaction {
  return { query: vi.fn(async () => ({ rows: row === null ? [] : [row], rowCount: row === null ? 0 : 1, command: "SELECT", oid: 0, fields: [] })) } as unknown as DbTransaction;
}
const binding = { run: { id: id(800) }, course: { id: id(803), ownerId: id(804) },
  approval: { id: id(805), draftRevision: 1, contentDigest: digest } } as ApprovedBuildBinding;
function stepRow() {
  return { id: id(801), input_digest: "b".repeat(64), result_reference: { kind: "checked", value: "material" },
    schema_digest: COURSE_GENERATION_SCHEMA_DIGEST, capability_digest: getCapabilityCatalogDigest(),
    validation_policy_digest: COURSE_VALIDATION_POLICY_DIGEST, approval_digest: digest };
}
describe("stored generation evidence boundary", () => {
  it("loads only the exact current run and compatible approval/schema/catalog/policy", async () => {
    const tx = txFor(stepRow());
    const result = await loadGenerationStep(tx, binding, id(801), z.object({ kind: z.literal("checked"), value: z.string() }).strict());
    expect(result.result.value).toBe("material");
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining("step.status='succeeded'"),
      [id(801), binding.run.id, binding.course.ownerId, binding.course.id, binding.approval.id, 1]);
  });
  it.each(["schema_digest", "capability_digest", "validation_policy_digest", "approval_digest"])("rejects stale %s without reusing the output", async (key) => {
    const row = stepRow(); Object.assign(row, { [key]: "f".repeat(64) });
    await expect(loadGenerationStep(txFor(row), binding, id(801), z.unknown())).rejects.toThrow("provider.invalid_output");
  });
  it("does not accept a missing step as proof", async () => {
    await expect(loadGenerationStep(txFor(null), binding, id(801), z.unknown())).rejects.toThrow("provider.invalid_output");
  });
  it("requires the actual saved structured provider content to match the claimed result", async () => {
    const model = providerRow();
    const expected = z.object({ answer: z.string() }).strict();
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "invented" })).rejects.toThrow("provider.invalid_output");
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "actual" })).resolves.toBeUndefined();
    model.state = "unknown";
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "actual" })).rejects.toThrow("provider.invalid_output");
  });
  it.each(["kimi-digitalocean-v1", "gemini-flash-google-schema-v2"] as const)("replays exact immutable %s identity", async (policy) => {
    await expect(verifyStoredModelDataAndIdentity(txFor(providerRow(policy)), { id: id(801), inputDigest: "b".repeat(64) }, id(802),
      z.object({ answer: z.string() }), { answer: "actual" })).resolves.toBe(modelPolicy(policy).model);
  });
  it.each(["model_id", "provider_tag", "rate_card_digest"])("rejects a mismatched immutable operation %s", async (field) => {
    const row = providerRow("gemini-flash-google-schema-v2"); Object.assign(row, { [field]: field === "rate_card_digest" ? "f".repeat(64) : "wrong" });
    await expect(verifyStoredModelData(txFor(row), { id: id(801), inputDigest: "b".repeat(64) }, id(802), z.object({ answer: z.string() }), { answer: "actual" })).rejects.toThrow("provider.invalid_output");
  });
  it("rejects a different response model even when it is otherwise supported", async () => {
    const row = providerRow("gemini-flash-google-schema-v2"); row.result.model = "moonshotai/kimi-k2.6";
    await expect(verifyStoredModelData(txFor(row), { id: id(801), inputDigest: "b".repeat(64) }, id(802), z.object({ answer: z.string() }), { answer: "actual" })).rejects.toThrow("provider.invalid_output");
  });
  it("requires the persisted same-job policy for v2 steps", async () => {
    const row = { ...stepRow(), schema_digest: COURSE_GENERATION_V2_SCHEMA_DIGEST, validation_policy_digest: COURSE_VALIDATION_V2_POLICY_DIGEST };
    await expect(loadGenerationStep(txFor(row), binding, id(801), z.unknown())).rejects.toThrow("provider.invalid_output");
    await expect(loadGenerationStep(txFor({ ...row, generation_policy: { result: { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: digest },
      schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, capability: getCapabilityCatalogDigest(), approval: digest } }), binding, id(801), z.unknown())).resolves.toBeDefined();
  });
});

describe("generation policy lineage", () => {
  const policy = { key: COURSE_GENERATION_POLICY_KEY, status: "succeeded", result: { kind: "course.generation.policy", version: "course-generation-batch-v2", batchSize: 5, maxOutputTokens: 16384, approvalDigest: digest },
    schema: COURSE_GENERATION_SCHEMA_DIGEST, validationPolicy: COURSE_VALIDATION_POLICY_DIGEST, capability: getCapabilityCatalogDigest(), approval: digest };
  const row = (steps: unknown[], depth = 0, retry: string | null = null) => ({ id: depth ? id(799) : binding.run.id, retry_of_run_id: retry, depth, steps });
  const lineageTx = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as DbTransaction;
  it("selects v2 only for pristine original builds", async () => {
    await expect(resolveGenerationPolicy(lineageTx([row([])]), binding)).resolves.toBe("batch-v2");
    await expect(resolveGenerationPolicy(lineageTx([row([{ ...policy, key: "course/old", status: "running", result: null }])]), binding)).resolves.toBe("legacy-v1");
  });
  it("inherits exact parent policy and preserves an empty legacy ancestor", async () => {
    await expect(resolveGenerationPolicy(lineageTx([row([], 0, id(799)), row([policy], 1)]), binding)).resolves.toBe("batch-v2");
    await expect(resolveGenerationPolicy(lineageTx([row([], 0, id(799)), row([], 1)]), binding)).resolves.toBe("legacy-v1");
    await expect(resolveGenerationPolicy(lineageTx([row([policy], 0, id(799)), row([], 1)]), binding)).rejects.toThrow("provider.invalid_output");
  });
  it("does not silently fall back when an ancestor or policy is malformed", async () => {
    await expect(resolveGenerationPolicy(lineageTx([row([], 0, id(799))]), binding)).rejects.toThrow("provider.invalid_output");
    await expect(resolveGenerationPolicy(lineageTx([row([{ ...policy, result: { ...policy.result, batchSize: 1 } }])]), binding)).rejects.toThrow("provider.invalid_output");
  });
  it("preserves v2 across an untouched failed intermediate retry", async () => {
    await expect(resolveGenerationPolicy(lineageTx([row([], 0, id(799)), row([], 1, id(798)),
      { ...row([policy], 2), id: id(798) }]), binding)).resolves.toBe("batch-v2");
  });
});
