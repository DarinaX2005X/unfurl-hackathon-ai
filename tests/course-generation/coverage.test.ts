import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateCourseCoverage } from "@/server/course-validation/coverage";
import { preparedFixture, rehash, id } from "./fixtures";

describe("whole-course criterion coverage", () => {
  it("accepts ordered grounded practice and independent demonstration for every approved outcome", () => {
    expect(validateCourseCoverage(preparedFixture(2).coverageInput)).toEqual([]);
  });
  it("does not silently drop a specialization outcome", () => {
    const data = preparedFixture(2);
    data.coverage.pop();
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "missing_outcome")).toBe(true);
  });
  it("rejects a missing approved section even when remaining tasks are numerous", () => {
    const data = preparedFixture(2); data.modules.pop();
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "missing_outcome")).toBe(true);
  });
  it("rejects a task as its own practice/transfer", () => {
    const data = preparedFixture();
    data.coverage[0]!.practicedTaskIds = [...data.coverage[0]!.demonstratedTaskIds];
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "invalid_transfer")).toBe(true);
  });
  it("rejects counterfeit introduction references", () => {
    const data = preparedFixture(); data.coverage[0]!.introducedAt[0]!.blockId = id(999);
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "unknown_reference")).toBe(true);
  });
  it("rejects modules presented before their prerequisites", () => {
    const data = preparedFixture(2); data.modules.reverse();
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "prerequisite_order")).toBe(true);
  });
  it("rejects practice before introduction", () => {
    const data = preparedFixture(), section = data.modules[0]!;
    section.lessons[0]!.blocks.reverse(); rehash(section);
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "prerequisite_order")).toBe(true);
  });
  it("does not accept a later edited candidate against its earlier preparation", () => {
    const data = preparedFixture(); data.modules[0]!.tasks[0]!.candidate.task.instruction += "Altered";
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "stale_candidate")).toBe(true);
  });
  it("requires demonstrated practice for every canonical criterion", () => {
    const data = preparedFixture(), section = data.modules[0]!;
    section.knowledge.outcomes[0]!.criteria.push({ id: "unassessed", description: "Explain when affine extrapolation is unwarranted." }); rehash(section);
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "criterion_mismatch")).toBe(true);
  });
  it("rejects claimed transfer that reuses the same evidence group", () => {
    const data = preparedFixture(), section = data.modules[0]!;
    section.tasks[1]!.candidate.privateTask.assessment.evidenceGroupId = section.tasks[0]!.candidate.privateTask.assessment.evidenceGroupId; rehash(section);
    expect(validateCourseCoverage(data.coverageInput).some((issue) => issue.code === "invalid_transfer")).toBe(true);
  });
});
