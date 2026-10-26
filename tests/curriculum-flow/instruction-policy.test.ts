import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { resolveCurriculumInstructionPolicy, curriculumInstructionPolicyKey, STRICT_RESEARCH_LINK_INSTRUCTIONS } from "../../src/server/curriculum-research/instruction-policy";
import { composeDurableCurriculum, type DurableCompositionInput } from "../../src/server/curriculum-research/durable-composer";
import * as parts from "../../src/server/curriculum-research/part-runtime";
import { jsonDigest } from "../../src/server/ai/json";
import type { DbTransaction } from "../../src/server/db";
import type { RunContext } from "../../src/server/runs/ports";
import type { ModelPort } from "../../src/server/ai/ports";
import { ids, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
function policyHarness(priorStatus?: string) {
  const rows: Record<string, unknown>[] = priorStatus ? [{ step_key: parts.curriculumPartKey(ids.request, "research", 0), status: priorStatus }] : [];
  let effects = 0;
  const tx = { query: vi.fn(async () => ({ rows })) } as unknown as DbTransaction;
  const context = { claim: { jobId: ids.task }, read: async <T>(work: (tx: DbTransaction) => Promise<T>) => work(tx),
    async step(spec) {
      effects++;
      const output = spec.outputSchema.parse(await spec.effect({ budgetOperation: () => { throw new Error("Policy must not reserve a model operation"); } } as never, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      rows.push({ step_key: spec.key, status: "succeeded", input_digest: jsonDigest(spec.input), schema_digest: spec.digests.schema,
        capability_digest: spec.digests.capability, validation_policy_digest: spec.digests.validationPolicy,
        approval_digest: spec.digests.approval, result_reference: result });
      return result;
    },
  } as RunContext;
  return { rows, context, tx, effects: () => effects };
}

it.each(["queued", "running", "failed", "succeeded", "cancelled"])("pins legacy producer for an existing %s part, including dispatched paid work", async status => {
  const test = policyHarness(status), before = JSON.stringify(test.rows[0]);
  expect(await resolveCurriculumInstructionPolicy(test.context, ids.request)).toBe("legacy-v2");
  expect(JSON.stringify(test.rows[0])).toBe(before);
  expect(await resolveCurriculumInstructionPolicy(test.context, ids.request)).toBe("legacy-v2");
  expect(test.effects()).toBe(1);
});

it("records the strict producer only for a pristine invocation and reuses it after parts exist", async () => {
  const test = policyHarness();
  expect(await resolveCurriculumInstructionPolicy(test.context, ids.request)).toBe("research-links-v1");
  expect(test.rows[0]).toMatchObject({ step_key: curriculumInstructionPolicyKey(ids.request),
    result_reference: { kind: "curriculum.instruction_policy", invocationId: ids.request, version: "research-links-v1" } });
  test.rows.push({ step_key: parts.curriculumPartKey(ids.request, "research", 0), status: "running" });
  const before = JSON.stringify(test.rows);
  expect(await resolveCurriculumInstructionPolicy(test.context, ids.request)).toBe("research-links-v1");
  expect(JSON.stringify(test.rows)).toBe(before);
  expect(test.effects()).toBe(1);
  expect(test.tx.query).toHaveBeenCalledWith(expect.not.stringContaining("status='succeeded'"),
    [ids.task, curriculumInstructionPolicyKey(ids.request), `curriculum.v2:${ids.request}:%`]);
});

it("rejects a modified saved policy instead of reselecting instructions for existing paid work", async () => {
  const test = policyHarness();
  await resolveCurriculumInstructionPolicy(test.context, ids.request);
  test.rows[0]!.input_digest = "f".repeat(64);
  await expect(resolveCurriculumInstructionPolicy(test.context, ids.request)).rejects.toThrow("provider.invalid_output");
  expect(test.effects()).toBe(1);
});

it("keeps legacy research request material, schema and instruction bytes while versioning only the new producer suffix", async () => {
  const data = await researchFixture(), inputs: Parameters<typeof parts.runCurriculumPart>[2][] = [], stop = new Error("Inspect only, no model or database calls");
  vi.spyOn(parts, "readCurriculumParts").mockResolvedValue(new Map());
  vi.spyOn(parts, "runCurriculumPart").mockImplementation(async (_context, _model, input) => { inputs.push(input); throw stop; });
  const context = { claim: { target: { kind: "agent_turn", runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
    branchId: ids.sample, inputMessageId: ids.missing } } } as RunContext;
  const input: DurableCompositionInput = { invocationId: ids.task, now, capturedDraft: data.draft, sources: [{ document: data.source, blockIds: ["b1"] }],
    decision: { tool: "revise_curriculum", input: { draftId: ids.draft, expectedRevision: 1, changes: [], sources: [{ sourceId: ids.source, blockIds: ["b1"] }] } } };
  for (const policy of [undefined, "legacy-v2", "research-links-v1"] as const) {
    await expect(composeDurableCurriculum(context, {} as ModelPort, { ...input, ...(policy ? { researchInstructionPolicy: policy } : {}) })).rejects.toBe(stop);
  }
  const [original, legacy, fresh] = inputs;
  expect(legacy!.request).toEqual(original!.request);
  expect(legacy!.instructions).toBe(original!.instructions);
  expect(legacy!.instructionVersion).toBeUndefined();
  expect(fresh!.request).toEqual(original!.request);
  expect(fresh!.outputSchema).toBe(original!.outputSchema);
  expect(fresh!.instructions).toBe(`${original!.instructions}\n${STRICT_RESEARCH_LINK_INSTRUCTIONS}`);
  expect(fresh!.instructionVersion).toBe("curriculum-parts-v2:research-links-v1");
  expect(fresh!.instructions).toContain("claim's outcomeIds MUST include the exact outcomeId");
  expect(fresh!.instructions).toContain("including an integrated or capstone outcome");
});
