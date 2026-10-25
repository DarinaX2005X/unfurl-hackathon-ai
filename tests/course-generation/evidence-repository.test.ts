import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import type { DbTransaction } from "@/server/db";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { loadGenerationStep, verifyStoredModelData } from "@/server/course-generation/repository";
import { COURSE_GENERATION_SCHEMA_DIGEST, COURSE_VALIDATION_POLICY_DIGEST } from "@/server/course-generation/checkpoints";
import { getCapabilityCatalogDigest } from "@/server/mechanics/catalog";
import { id, digest } from "./fixtures";

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
    const model = { operation_id: id(802), run_step_id: id(801), input_digest: "b".repeat(64), request_digest: "c".repeat(64), response_digest: "d".repeat(64), provider_request_id: "mock-contract-only", rate_card_digest: "e".repeat(64), state: "settled", usage: {}, result: { model: "moonshotai/kimi-k2.6", failure: null, finishReason: "stop", content: JSON.stringify({ answer: "actual" }) } };
    const expected = z.object({ answer: z.string() }).strict();
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "invented" })).rejects.toThrow("provider.invalid_output");
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "actual" })).resolves.toBeUndefined();
    model.state = "unknown";
    await expect(verifyStoredModelData(txFor(model), { id: id(801), inputDigest: "b".repeat(64) }, id(802), expected, { answer: "actual" })).rejects.toThrow("provider.invalid_output");
  });
});
