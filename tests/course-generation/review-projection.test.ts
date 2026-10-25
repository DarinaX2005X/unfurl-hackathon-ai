import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assessContentReview, createContentReviewInput, CONTENT_REVIEW_CATEGORIES, type ContentReview } from "@/server/course-validation/content-review";
import { projectCompletedModuleProgress, projectModuleLearningContent } from "@/server/course-materialization/projection";
import { preparedFixture, privateMarker, id } from "./fixtures";

function reviewFixture() {
  const data = preparedFixture(), candidate = data.modules[0]!.tasks[0]!.candidate;
  const material = createContentReviewInput({ candidate, criteria: data.knowledge[0]!.outcomes[0]!.criteria, learnerAction: data.knowledge[0]!.outcomes[0]!.learnerAction, claims: data.claims, passages: [data.passage] });
  const review: ContentReview = { candidateDigest: candidate.candidateDigest, checks: CONTENT_REVIEW_CATEGORIES.map((category) => ({ category, status: "passed", explanation: "Synthetic response exercising the review contract only." })), findings: [] };
  return { ...data, candidate, material, review };
}
describe("independent review evidence and public projections", () => {
  it("excludes author rationale and desired verdict from independent review material", () => {
    const data = reviewFixture(), text = JSON.stringify(data.material);
    expect(text).not.toContain("mechanicRationale"); expect(text).not.toContain("requiredChecks"); expect(text).not.toContain("desiredVerdict");
    expect(text).toContain("privateTask"); // The reviewer must be able to challenge the evaluator itself.
    expect(assessContentReview(data.review, data.material).decision.outcome).toBe("correct");
  });
  it("preserves an evidenced uncertain finding as uncertainty", () => {
    const data = reviewFixture();
    data.review.checks[0]!.status = "uncertain";
    data.review.findings.push({ category: "accuracy", severity: "uncertain", taskId: data.candidate.task.id, outcomeIds: data.candidate.task.outcomeIds, explanation: "Synthetic unresolved scope.", correction: "Provide the missing scope evidence.", evidence: [{ path: ["task", "instruction"], value: data.candidate.task.instruction }] });
    expect(assessContentReview(data.review, data.material).decision.status).toBe("uncertain");
  });
  it.each(["invented_evidence", "missing_check", "wrong_candidate", "wrong_task", "unsupported_failure"])("rejects an invalid review: %s", (kind) => {
    const data = reviewFixture();
    if (kind === "wrong_candidate") data.review.candidateDigest = "e".repeat(64);
    if (kind === "missing_check") data.review.checks[0]!.category = data.review.checks[1]!.category;
    if (kind === "unsupported_failure") data.review.checks[0]!.status = "failed";
    if (kind === "invented_evidence" || kind === "wrong_task") data.review.findings.push({ category: "accuracy", severity: "advisory", taskId: kind === "wrong_task" ? id(999) : data.candidate.task.id, outcomeIds: data.candidate.task.outcomeIds, explanation: "Synthetic finding.", correction: "Inspect the referenced instruction.", evidence: [{ path: ["task", "instruction"], value: kind === "invented_evidence" ? "Not in actual content" : data.candidate.task.instruction }] });
    expect(() => assessContentReview(data.review, data.material)).toThrow();
  });
  it("keeps private evaluator, hints, example and validation material out of learning and progress payloads", () => {
    const data = preparedFixture(), learning = JSON.stringify(projectModuleLearningContent(data.modules[0])), progress = projectCompletedModuleProgress(data.modules[0]);
    expect(learning).not.toContain(privateMarker);
    for (const privateField of ["evaluatorData", "evaluationSpec", "sourceClaimIds", "assessment", "candidateDigest", "mechanicRationale", "hints", "workedExample"]) expect(learning).not.toContain(`\"${privateField}\"`);
    expect(progress).toEqual({ moduleId: data.modules[0]!.moduleId, completedTasks: 2 });
    expect(Object.keys(progress)).toEqual(["moduleId", "completedTasks"]);
  });
});
