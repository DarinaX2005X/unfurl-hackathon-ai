import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { selectSupportMaterial } from "@/server/adaptation/material";
import { program } from "../learning-runtime/fixtures";

describe("bounded validated support selection", () => {
  const input = () => { const data = program(); return { ...data, evidence: [], targetOutcomeId: data.version.outcomes[0]!.id,
    reasonCode: "additional_practice" as const, currentTaskId: data.tasks[2]!.task.id }; };
  it("uses only optional criterion-compatible same-program material and preserves required tasks", () => {
    const value = input(), material = selectSupportMaterial(value)!;
    expect(material.tasks.map(({ taskId }) => taskId)).toEqual([value.tasks[1]!.task.id]);
    expect(material.completionCheck).toEqual({ taskId: value.tasks[1]!.task.id, dimensionIds: ["state"] });
    expect(material.explanationBlock).toEqual({ lessonId: value.lessons[0]!.id, blockId: value.lessons[0]!.blocks[0]!.id });
    expect(material.estimatedStudyMinutes).toBe(5);
  });
  it("does not substitute reading or another criterion for a requested task type", () => {
    const value = input();
    expect(selectSupportMaterial({ ...value, reasonCode: "challenge" })).toBeNull();
    expect(selectSupportMaterial({ ...value, reasonCode: "diagnostic_clarification" })).toBeNull();
    expect(selectSupportMaterial({ ...value, dimensionIds: ["unknown"] })).toBeNull();
    expect(selectSupportMaterial({ ...value, currentTaskId: value.tasks[1]!.task.id })).toBeNull();
  });
  it("allows explanation-only help but never infers a prerequisite gap from downstream errors", () => {
    const value = input();
    expect(selectSupportMaterial({ ...value, reasonCode: "explanation" })).toMatchObject({ tasks: [], completionCheck: null, estimatedStudyMinutes: 2 });
    expect(selectSupportMaterial({ ...value, reasonCode: "prerequisite_support" })).toBeNull();
    expect(selectSupportMaterial({ ...value, targetOutcomeId: crypto.randomUUID() })).toBeNull();
  });
});
