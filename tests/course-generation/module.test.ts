import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { validateModuleKnowledge } from "@/server/course-validation/knowledge";
import { fixture, id } from "./fixtures";

describe("source-grounded section preparation", () => {
  it("prepares actual deterministic tasks without issuing readiness evidence", () => {
    const data = fixture(), result = prepareModuleCandidate(data.authored[0], { ...data.context, knowledge: data.knowledge[0] });
    expect(result.issues).toEqual([]);
    expect(result.candidate!.tasks).toHaveLength(2);
    expect(result.candidate!.tasks[0]!.candidate.requiredChecks.map((check) => check.id)).toContain("content_review");
    expect(JSON.stringify(result.candidate)).not.toContain("validationReceiptId");
  });
  it.each(["approval", "outcome", "claimOwner", "passage", "sourceDigest", "conflict"])("rejects %s mismatch", (kind) => {
    const data = fixture();
    if (kind === "approval") data.knowledge[0]!.approvalDigest = "c".repeat(64);
    if (kind === "outcome") data.knowledge[0]!.outcomes[0]!.outcomeId = id(999);
    if (kind === "claimOwner") data.claims[0]!.ownerId = id(999);
    if (kind === "passage") data.passage.quote = "A source quote that was never read.";
    if (kind === "sourceDigest") data.source.blocks[0]!.text += "Changed after read.";
    if (kind === "conflict") data.claims[0]!.unresolvedConflicts.push({ description: "The source contradicts the proposed scope.", otherClaimIds: [], blocking: true });
    expect(validateModuleKnowledge(data.knowledge[0], data.context).length).toBeGreaterThan(0);
    expect(prepareModuleCandidate(data.authored[0], { ...data.context, knowledge: data.knowledge[0] }).candidate).toBeNull();
  });
  it("rejects impossible affine observations through the actual family schema", () => {
    const data = fixture();
    data.authored[0]!.tasks[0]!.task.config.pairs = [[0, 1], [1, 3], [2, 99]];
    const result = prepareModuleCandidate(data.authored[0], { ...data.context, knowledge: data.knowledge[0] });
    expect(result.candidate).toBeNull();
    expect(result.issues.some((issue) => issue.code === "invalid_task")).toBe(true);
  });
  it.each(["unknown_mechanic", "invented_affordance", "private_field", "authored_receipt", "criterion", "language", "missing_claim"])("rejects invalid authored task: %s", (kind) => {
    const data = fixture(), entry = data.authored[0]!.tasks[0]!;
    if (kind === "unknown_mechanic") entry.task.mechanicVersion = 700;
    if (kind === "invented_affordance") entry.design.affordances.push("arbitrary_javascript_execution");
    if (kind === "private_field") entry.task.config.hiddenAnswer = "secret";
    if (kind === "authored_receipt") Object.assign(entry.privateTask, { validationReceiptId: id(999) });
    if (kind === "criterion") entry.privateTask.assessment.outcomes[0]!.dimensions[0]!.dimensionId = "invented";
    if (kind === "language") entry.task.contentLanguage = "ru";
    if (kind === "missing_claim") entry.privateTask.sourceClaimIds = [];
    expect(prepareModuleCandidate(data.authored[0], { ...data.context, knowledge: data.knowledge[0] }).candidate).toBeNull();
  });
  it.each(["orphan_task", "duplicate_task", "empty_reading", "missing_grounding", "foreign_lesson", "optional_only"])("rejects lesson join defect: %s", (kind) => {
    const data = fixture(), section = data.authored[0]!, lesson = section.lessons[0]!;
    if (kind === "orphan_task") { lesson.blocks.pop(); lesson.taskIds.pop(); }
    if (kind === "duplicate_task") lesson.blocks.push({ id: id(999), kind: "task", taskId: lesson.taskIds[0]! });
    if (kind === "empty_reading") { const block = lesson.blocks[0]!; if (block.kind === "explanation") block.markdown = "   "; }
    if (kind === "missing_grounding") section.readingEvidence = [];
    if (kind === "foreign_lesson") lesson.courseVersionId = id(999);
    if (kind === "optional_only") { lesson.blocks.shift(); section.readingEvidence = []; section.tasks.forEach((entry) => { entry.privateTask.assessment.role = "practice"; }); }
    expect(prepareModuleCandidate(section, { ...data.context, knowledge: data.knowledge[0] }).candidate).toBeNull();
  });
  it("allows a real reading-only section candidate without inventing a task", () => {
    const data = fixture(), section = data.authored[0]!;
    section.tasks = [];
    section.lessons[0]!.taskIds = [];
    section.lessons[0]!.blocks = section.lessons[0]!.blocks.slice(0, 1);
    expect(prepareModuleCandidate(section, { ...data.context, knowledge: data.knowledge[0] }).issues).toEqual([]);
  });
});
