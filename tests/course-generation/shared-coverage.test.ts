import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateCurriculum } from "@/domain/course";
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { mergeOutcomeCoverage, validateCourseCoverage } from "@/server/course-validation/coverage";
import { fixture } from "./fixtures";

function sharedFixture(count = 2, extendCriterion = false) {
  const data = fixture(count), index = count - 1, shared = data.draft.outcomes[0]!.id, removed = data.draft.outcomes[index]!.id;
  data.draft.outcomes.splice(index, 1);
  data.draft.modules[index]!.outcomeIds = [shared]; data.claims[index]!.outcomeIds = [shared];
  data.knowledge[index]!.outcomes[0]!.outcomeId = shared; data.coverage[index]!.outcomeId = shared;
  data.authored[index] = JSON.parse(JSON.stringify(data.authored[index]).replaceAll(removed, shared)) as typeof data.authored[number];
  if (extendCriterion) {
    data.knowledge[index]!.outcomes[0]!.criteria = [{ id: "affine_extension", description: "Apply the additional approved criterion in a later context." }];
    for (const task of data.authored[index]!.tasks) task.privateTask.assessment.outcomes[0]!.dimensions[0]!.dimensionId = "affine_extension";
  }
  const modules = data.authored.map((authored, n) => {
    const prepared = prepareModuleCandidate(authored, { ...data.context, knowledge: data.knowledge[n] });
    expect(prepared.issues).toEqual([]);
    return prepared.candidate!;
  });
  return { ...data, modules, input: { ...data.context, modules, coverage: mergeOutcomeCoverage(data.coverage) } };
}
describe("outcomes shared by multiple approved modules", () => {
  it("merges one outcome while retaining all module introductions, tasks and transfer evidence", () => {
    const data = sharedFixture();
    expect(validateCurriculum(data.draft)).toEqual([]);
    expect(validateCourseCoverage({ ...data.input, coverage: data.coverage }).some((issue) => issue.code === "missing_outcome")).toBe(true);
    expect(validateCourseCoverage(data.input)).toEqual([]);
    expect(data.input.coverage).toHaveLength(1);
    expect(data.input.coverage[0]!.introducedAt).toEqual(data.coverage.flatMap((entry) => entry.introducedAt));
    expect(data.input.coverage[0]!.practicedTaskIds).toEqual(data.coverage.flatMap((entry) => entry.practicedTaskIds));
    expect(data.input.coverage[0]!.demonstratedTaskIds).toEqual(data.coverage.flatMap((entry) => entry.demonstratedTaskIds));
    expect(data.coverage.every((entry) => entry.practicedTaskIds.length === 1)).toBe(true);
  });
  it("retains additional criteria and still requires their distinct practice and demonstration", () => {
    const data = sharedFixture(2, true);
    expect(validateCourseCoverage(data.input)).toEqual([]);
    data.input.coverage[0]!.demonstratedTaskIds.pop();
    expect(validateCourseCoverage(data.input).some((issue) => issue.code === "criterion_mismatch")).toBe(true);
  });
  it("does not hide duplicate or borrowed evidence while merging", () => {
    const data = sharedFixture();
    data.coverage[1]!.practicedTaskIds = [...data.coverage[0]!.practicedTaskIds];
    const merged = mergeOutcomeCoverage(data.coverage);
    expect(merged[0]!.practicedTaskIds).toHaveLength(2);
    expect(validateCourseCoverage({ ...data.input, coverage: merged }).some((issue) => issue.code === "invalid_shape")).toBe(true);
  });
  it("allows later reinforcement after a dependent module without losing prerequisite checks", () => {
    const repeated = sharedFixture(3);
    expect(validateCourseCoverage(repeated.input)).toEqual([]);
    const incompletePrerequisite = sharedFixture(3, true);
    expect(validateCourseCoverage(incompletePrerequisite.input).some((issue) => issue.code === "prerequisite_order")).toBe(true);
  });
});
