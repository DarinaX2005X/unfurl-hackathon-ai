import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { deriveCriterionCoverage, mapCanonicalDimensions, type ConfirmableEvidence } from "@/server/learning/evidence";
import type { GradeDecision } from "@/server/evaluation/contracts";
import { program } from "./fixtures";

const grade = (statuses: Array<[string, "met" | "partial" | "not_met"]>): GradeDecision => ({ status: "evaluated", outcome: "partial",
  dimensions: statuses.map(([id, status]) => ({ id, status, explanation: "Synthetic criterion result" })), feedback: { explanation: "Synthetic result", nextAction: "revise" } });
function observation(input: ReturnType<typeof program>, taskIndex = 0): ConfirmableEvidence {
  const entry = input.tasks[taskIndex]!;
  return { id: crypto.randomUUID(), enrollmentId: input.enrollmentId, courseVersionId: input.version.id,
    attemptId: crypto.randomUUID(), evaluationId: crypto.randomUUID(), evaluationRevision: 1, currentEvaluationRevision: 1,
    evaluationStatus: "evaluated", taskId: entry.task.id, taskVersion: entry.task.taskVersion,
    evidenceGroupId: entry.assessment.evidenceGroupId, assistance: "independent", reviewState: "confirmed",
    outcomeId: input.version.outcomes[0]!.id, dimensionStatuses: { state: "met" }, submittedAt: "2026-10-25T00:00:00Z", feedbackAcknowledgedAt: null };
}
describe("canonical criterion evidence", () => {
  it("requires every local conjunct and never converts a missing dimension or uncertain review into knowledge failure", () => {
    const assessment = program().tasks[0]!.assessment;
    assessment.outcomes[0]!.dimensions[0]!.evaluationDimensionIds = ["numeric_cases", "explanation"];
    expect(mapCanonicalDimensions(assessment, grade([["numeric_cases", "met"]]))[0]!.dimensionStatuses).toEqual({ state: "uncertain" });
    expect(mapCanonicalDimensions(assessment, grade([["numeric_cases", "met"], ["explanation", "partial"]]))[0]!.dimensionStatuses).toEqual({ state: "partial" });
    expect(mapCanonicalDimensions(assessment, grade([["numeric_cases", "met"], ["explanation", "met"]]))[0]!.dimensionStatuses).toEqual({ state: "met" });
    expect(mapCanonicalDimensions(assessment, { status: "uncertain", outcome: null,
      dimensions: [{ id: "numeric_cases", status: "not_met", explanation: "Unresolved review" }], feedback: { explanation: "Needs review", nextAction: "clarify" } })[0]!.dimensionStatuses).toEqual({ state: "uncertain" });
  });
  it("allows validated alternate hinted success but requires normal traversal independently", () => {
    const input = program();
    const evidence = observation(input, 1); evidence.assistance = "hinted";
    const covered = deriveCriterionCoverage({ ...input, evidence: [evidence], traversedLessonIds: [] });
    expect(covered.completedRequiredOutcomes).toBe(1);
    expect(covered.completed).toBe(false);
    expect(deriveCriterionCoverage({ ...input, evidence: [evidence], traversedLessonIds: input.version.lessonIds }).completed).toBe(true);
  });
  it("excludes reveal reproduction, stale revisions, contested results and foreign version evidence", () => {
    const input = program(), original = observation(input);
    for (const changes of [
      { assistance: "worked_example" as const }, { evaluationRevision: 1, currentEvaluationRevision: 2 },
      { reviewState: "contested" as const }, { evaluationStatus: "uncertain" as const },
      { courseVersionId: crypto.randomUUID() }, { enrollmentId: crypto.randomUUID() }, { evidenceGroupId: crypto.randomUUID() },
    ]) {
      const result = deriveCriterionCoverage({ ...input, evidence: [{ ...original, ...changes }], traversedLessonIds: input.version.lessonIds });
      expect(result.completedRequiredOutcomes).toBe(0);
      expect(result.requiredProgramTraversed).toBe(true);
      expect(result.completed).toBe(false);
    }
  });
});
