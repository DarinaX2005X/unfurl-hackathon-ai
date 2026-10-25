import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { MODULE_REVIEW_CATEGORIES, assessModuleReview, createModuleReviewInput, type ModuleReviewSchema } from "@/server/course-validation/module-review";
import { assessSpecializedReview } from "@/server/course-validation/specialized-review";
import { validateModulePlan, type ModulePlan } from "@/server/course-generation/planning";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import type { z } from "zod";
import { id, preparedFixture } from "./fixtures";

const runtime: MechanicRuntimeCapabilities = { model: { modelId: "moonshotai/kimi-k2.6", available: true }, activity: { durable: true, supportedActions: [], dialogue: false }, sandbox: { available: false, profiles: [] }, budget: { available: true } };
function reviewFixture() {
  const fixture = preparedFixture(), section = fixture.modules[0]!, material = createModuleReviewInput(section, fixture.draft, fixture.context);
  const review: z.infer<typeof ModuleReviewSchema> = { moduleDigest: section.moduleDigest,
    checks: MODULE_REVIEW_CATEGORIES.map((category) => ({ category, outcomeId: fixture.draft.outcomes[0]!.id, status: "passed", explanation: "Synthetic review contract evidence only.", correction: null,
      evidence: [{ path: ["lessons", 0, "title"], value: section.lessons[0]!.title }] })) };
  return { fixture, section, material, review };
}
describe("module and specialized review evidence", () => {
  it("omits author rationale and checks every approved outcome/category", () => {
    const data = reviewFixture();
    expect(JSON.stringify(data.material)).not.toContain("mechanicRationale");
    expect(assessModuleReview(data.review, data.material).passed).toBe(true);
    data.review.checks.pop();
    expect(() => assessModuleReview(data.review, data.material)).toThrow();
  });
  it("does not accept invented citations or duplicated checks as proof of depth", () => {
    const data = reviewFixture(); data.review.checks[0]!.evidence[0]!.value = "Unseen evidence";
    expect(() => assessModuleReview(data.review, data.material)).toThrow("evidence");
    const duplicate = reviewFixture(); duplicate.review.checks[0]!.category = duplicate.review.checks[1]!.category;
    expect(() => assessModuleReview(duplicate.review, duplicate.material)).toThrow();
  });
  it("preserves uncertainty and requires actionable corrections", () => {
    const data = reviewFixture(); data.review.checks[0]!.status = "uncertain";
    expect(() => assessModuleReview(data.review, data.material)).toThrow();
    data.review.checks[0]!.correction = "Add the missing prerequisite explanation.";
    expect(assessModuleReview(data.review, data.material).passed).toBe(false);
  });
  it("specialized decisions derive the exact required invariant from evidenced review", () => {
    const material = { candidateDigest: "a".repeat(64), claim: "Synthetic implication" };
    const review = { candidateDigest: material.candidateDigest, validator: "validateCounterexampleClaim", status: "passed", explanation: "Synthetic local contract only.", correction: null, evidence: [{ path: ["claim"], value: material.claim }] };
    expect(assessSpecializedReview(review, material).dimensions.map((d) => d.id)).toEqual(["coded_implication"]);
    review.evidence[0]!.value = "Different implication";
    expect(() => assessSpecializedReview(review, material)).toThrow();
  });
});
describe("early pedagogical planning gate", () => {
  function planFixture() {
    const data = preparedFixture(), authored = data.authored[0]!, knowledge = data.knowledge[0]!;
    const plan: ModulePlan = { moduleId: authored.moduleId, coverage: data.coverage, lessons: authored.lessons.map((lesson) => ({ id: lesson.id, title: lesson.title, outcomeIds: lesson.outcomeIds,
      blocks: lesson.blocks.map((block) => block.kind === "task" ? block : { id: block.id, kind: block.kind, outcomeIds: lesson.outcomeIds, claimIds: [data.claims[0]!.id], teachingPurpose: "Teach the prerequisite reasoning.", title: null }) })),
      tasks: authored.tasks.map((entry) => ({ id: entry.task.id, lessonId: authored.lessons[0]!.id, outcomeIds: entry.task.outcomeIds, mechanicId: entry.task.mechanicId, mechanicVersion: entry.task.mechanicVersion, design: entry.design,
        assessmentRole: "required",
        criteria: [{ outcomeId: entry.task.outcomeIds[0]!, criterionIds: ["affine_rule"] }] })) };
    for (const [index, assessmentRole] of (["practice", "diagnostic", "challenge"] as const).entries()) {
      const taskId = id(950 + index), slot = structuredClone(plan.tasks[0]!);
      plan.tasks.push({ ...slot, id: taskId, assessmentRole, design: { ...slot.design, taskId, purpose: "support", transfer: null } });
      plan.lessons[0]!.blocks.push({ id: id(960 + index), kind: "task", taskId });
    }
    return { data, plan, context: { draft: data.draft, knowledge, runtime } };
  }
  it("rejects unsupported criterion coverage before task authoring can incur cost", () => {
    const data = planFixture(); expect(validateModulePlan(data.plan, data.context)).toEqual([]);
    data.context.knowledge.outcomes[0]!.criteria.push({ id: "new_criterion", description: "A distinct competency with no planned demonstration." });
    expect(validateModulePlan(data.plan, data.context).some((issue) => issue.code === "criterion_mismatch")).toBe(true);
  });
  it("rejects future or unrelated practice references in transfer design", () => {
    const data = planFixture(); data.plan.tasks[1]!.design.transfer!.fromTaskIds = [id(999)];
    expect(validateModulePlan(data.plan, data.context).some((issue) => issue.code === "invalid_transfer")).toBe(true);
  });
});
