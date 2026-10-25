import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { selectFreshAssessment } from "@/server/adaptation/fresh-assessment";
import { program } from "./fixtures";

describe("fresh criterion assessment selection", () => {
  const input = () => ({ ...program(), evidence: [], exposedTaskIds: new Set<string>(), exposedGroupIds: new Set<string>() });
  it("selects only same-version optional canonical material, never an upcoming required task", () => {
    const value = input();
    expect(selectFreshAssessment(value)?.entry.task.id).toBe(value.tasks[1]!.task.id);
    expect(selectFreshAssessment({ ...value, targetCriteria: new Map([[value.version.outcomes[0]!.id, new Set(["unrelated"])]]) })).toBeNull();
    value.tasks[1]!.assessment.outcomes[0]!.dimensions[0]!.dimensionId = "unrelated";
    expect(selectFreshAssessment(value)).toBeNull();
  });
  it("does not rename known evidence into an independent opportunity or reuse an exposed task", () => {
    const value = input(), optional = value.tasks[1]!;
    value.exposedGroupIds.add(optional.assessment.evidenceGroupId);
    expect(selectFreshAssessment(value)).toBeNull();
    value.exposedGroupIds.clear(); value.exposedTaskIds.add(optional.task.id);
    expect(selectFreshAssessment(value)).toBeNull();
    value.exposedTaskIds.clear(); value.lessons[1]!.courseVersionId = crypto.randomUUID();
    expect(selectFreshAssessment(value)).toBeNull();
  });
});
