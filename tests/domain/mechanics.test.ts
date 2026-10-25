import { describe, expect, it } from "vitest";
import { TaskAssessmentSchema, TaskEvaluatorDataSchema, TaskPrivateSchema, serializePublicTask } from "@/domain/mechanics";
import { JsonObjectSchema } from "@/domain/common";
import { task, induction, tolerance } from "../mechanics/foundations/fixtures";

const outcomeId = "e47664e5-2555-4dba-8b9b-79e84e367f86";
function privateTask() {
  return { taskId: task(induction).id, taskVersion: 1,
    evaluationSpec: { kind: "deterministic", evaluatorId: "rule_induction", evaluatorVersion: 2, secretConfig: null },
    evaluatorData: { tolerance }, assessment: { evidenceGroupId: "79b906f4-9abb-40ec-ae7e-398ab9c041b7", role: "required",
      outcomes: [{ outcomeId, dimensions: [{ dimensionId: "affine_relationship", evaluationDimensionIds: ["slope", "intercept", "new_inputs"] }] }] },
    sourceClaimIds: [], validationReceiptId: "d242960c-fbe2-4821-9ba4-d10a70633d18", hints: [], workedExample: null,
  };
}
describe("canonical private envelope", () => {
  it("bounds evaluator data by actual UTF-8 bytes and preserves its family-specific structure", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ text: "" })).byteLength;
    const exact = { text: "a".repeat(128 * 1024 - overhead) };
    expect(TaskEvaluatorDataSchema.safeParse(exact).success).toBe(true);
    expect(TaskEvaluatorDataSchema.safeParse({ text: exact.text + "a" }).success).toBe(false);
    expect(TaskEvaluatorDataSchema.safeParse({ text: "я".repeat(70_000) }).success).toBe(false);
    expect(TaskEvaluatorDataSchema.parse({ tolerance })).toEqual({ tolerance });
    expect(TaskEvaluatorDataSchema.safeParse(null).success).toBe(false);
  });
  it("rejects cycles, accessors, nonfinite values and excessive depth before recursive parsing", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(TaskEvaluatorDataSchema.safeParse(cycle).success).toBe(false);
    let accessed = false;
    const accessor = { get answer() { accessed = true; return 42; } };
    expect(TaskEvaluatorDataSchema.safeParse(accessor).success).toBe(false);
    expect(accessed).toBe(false);
    expect(TaskEvaluatorDataSchema.safeParse({ value: Infinity }).success).toBe(false);
    let deep: unknown = 0; for (let index = 0; index < 40; index++) deep = { next: deep };
    expect(TaskEvaluatorDataSchema.safeParse(deep).success).toBe(false);
    expect(TaskEvaluatorDataSchema.safeParse({ date: new Date() }).success).toBe(false);
  });
  it("allows at most six bounded hints and a bounded optional worked example", () => {
    const value = privateTask();
    const limit = { ...value, hints: Array.from({ length: 6 }, () => "x".repeat(4000)), workedExample: "y".repeat(12000) };
    expect(TaskPrivateSchema.safeParse(limit).success).toBe(true);
    expect(TaskPrivateSchema.safeParse({ ...limit, hints: [...limit.hints, "another"] }).success).toBe(false);
    expect(TaskPrivateSchema.safeParse({ ...limit, hints: ["x".repeat(4001)] }).success).toBe(false);
    expect(TaskPrivateSchema.safeParse({ ...limit, workedExample: "y".repeat(12001) }).success).toBe(false);
    expect(TaskPrivateSchema.safeParse({ ...value, workedExample: "   " }).success).toBe(false);
    expect(TaskPrivateSchema.safeParse({ ...value, validationReceiptId: undefined }).success).toBe(false);
  });
  it("rejects duplicate/reserved criteria and never treats local IDs as implicit canonical criteria", () => {
    const assessment = privateTask().assessment;
    expect(TaskAssessmentSchema.parse(assessment).outcomes[0]!.dimensions[0]).toEqual({
      dimensionId: "affine_relationship", evaluationDimensionIds: ["slope", "intercept", "new_inputs"],
    });
    const outcome = assessment.outcomes[0]!;
    expect(TaskAssessmentSchema.safeParse({ ...assessment, outcomes: [outcome, outcome] }).success).toBe(false);
    for (const dimensionId of ["__proto__", "constructor", "prototype"]) {
      expect(TaskAssessmentSchema.safeParse({ ...assessment, outcomes: [{ ...outcome,
        dimensions: [{ dimensionId, evaluationDimensionIds: ["slope"] }] }] }).success).toBe(false);
    }
    expect(TaskAssessmentSchema.safeParse({ ...assessment, outcomes: [{ ...outcome, dimensions: [{ dimensionId: "a", evaluationDimensionIds: [] }] }] }).success).toBe(false);
  });
  it("projects only public top-level fields and rejects nested private payloads", () => {
    const publicTask = task(induction);
    expect(serializePublicTask({ ...publicTask, ...privateTask() }, JsonObjectSchema)).toEqual(publicTask);
    for (const key of ["evaluatorData", "assessment", "workedExample", "rubric", "basisRubric", "explanationRubric", "acceptedGraphs", "acceptedEvidence", "hiddenFacts", "permittedOutcomes", "oracle", "hiddenCases", "acceptedFaultRegions", "repairLocationDimensionId", "testSetId"]) {
      expect(() => serializePublicTask({ ...publicTask, config: { publicMaterial: [{ nested: { [key]: "private" } }] } }, JsonObjectSchema)).toThrow(/private field/);
    }
  });
});
