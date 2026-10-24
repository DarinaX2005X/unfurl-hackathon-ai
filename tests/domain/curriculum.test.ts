import { describe, expect, it } from "vitest";
import {
  assertCurrentApproval, curriculumDigest, validateCurriculum,
  type CurriculumApproval, type CurriculumDraft,
} from "../../src/domain/course";
import { curriculum, ids, timestamp } from "./fixtures";

async function approve(draft: CurriculumDraft): Promise<CurriculumApproval> {
  return {
    id: ids.approval, draftId: draft.id, draftRevision: draft.revision,
    contentDigest: await curriculumDigest(draft), approvedBy: ids.actor, approvedAt: timestamp,
  };
}

describe("curriculum structure", () => {
  it("accepts a connected learning progression with covered core outcomes", () => {
    expect(validateCurriculum(curriculum())).toEqual([]);
  });

  it("identifies dangling outcome and module references", () => {
    const draft = curriculum();
    draft.modules[1]!.outcomeIds.push(ids.missing);
    draft.modules[1]!.prerequisiteModuleIds.push(ids.missing);
    draft.outcomes[1]!.prerequisiteOutcomeIds.push(ids.missing);
    expect(validateCurriculum(draft).filter((issue) => issue.code === "unknown_reference"))
      .toHaveLength(3);
  });

  it("rejects cycles in both prerequisite graphs", () => {
    const draft = curriculum();
    draft.outcomes[0]!.prerequisiteOutcomeIds = [ids.outcomeB];
    draft.modules[0]!.prerequisiteModuleIds = [ids.moduleB];
    expect(validateCurriculum(draft).filter((issue) => issue.code === "cycle").map((issue) => issue.path))
      .toEqual([["outcomes"], ["modules"]]);
  });

  it("rejects item identity collisions and repeated references", () => {
    const draft = curriculum();
    draft.modules[0]!.id = ids.outcomeA;
    draft.modules[0]!.outcomeIds.push(ids.outcomeA);
    draft.sourceIds.push(ids.source);
    expect(validateCurriculum(draft).filter((issue) => issue.code === "duplicate_id"))
      .toHaveLength(3);
  });

  it("requires coverage for core outcomes and positive study estimates", () => {
    const draft = curriculum();
    draft.modules[1]!.outcomeIds = [ids.outcomeA];
    draft.modules[0]!.estimatedStudyMinutes = 0;
    expect(validateCurriculum(draft).map((issue) => issue.code))
      .toEqual(["uncovered_outcome", "invalid_estimate"]);
    draft.outcomes[1]!.requirement = "specialization";
    draft.modules[0]!.estimatedStudyMinutes = 1;
    expect(validateCurriculum(draft)).toEqual([]);
  });

  it("reports malformed content before traversing relationships", () => {
    const draft = curriculum();
    draft.modules[0]!.estimatedStudyMinutes = Number.NaN;
    expect(validateCurriculum(draft)[0]).toMatchObject({
      code: "invalid_shape", path: ["modules", 0, "estimatedStudyMinutes"],
    });
  });
});

describe("approval integrity", () => {
  it("accepts the unchanged draft and rejects changed revision or identity", async () => {
    const draft = curriculum();
    const approval = await approve(draft);
    await expect(assertCurrentApproval(draft, approval)).resolves.toBeUndefined();
    await expect(assertCurrentApproval({ ...draft, revision: 2 }, approval))
      .rejects.toMatchObject({ code: "approval_conflict", reason: "revision_mismatch" });
    await expect(assertCurrentApproval({ ...draft, id: ids.missing }, approval))
      .rejects.toMatchObject({ code: "approval_conflict", reason: "draft_mismatch" });
  });

  it.each(["title", "contentLanguage", "goal"] as const)("invalidates approval after a %s change", async (field) => {
    const draft = curriculum();
    const approval = await approve(draft);
    const value = field === "contentLanguage" ? "ru" : "A revised learning goal";
    await expect(assertCurrentApproval({ ...draft, [field]: value }, approval))
      .rejects.toMatchObject({ code: "approval_conflict", reason: "content_mismatch" });
  });

  it("cannot approve required open questions or a structurally invalid plan", async () => {
    const draft = curriculum();
    draft.unresolvedQuestions.push({ id: ids.question, text: "Which audience is this for?", blocking: true });
    await expect(assertCurrentApproval(draft, await approve(draft)))
      .rejects.toMatchObject({ code: "approval_conflict", reason: "blocking_questions" });
    draft.unresolvedQuestions = [];
    draft.modules[0]!.outcomeIds = [ids.missing];
    await expect(assertCurrentApproval(draft, await approve(draft)))
      .rejects.toMatchObject({ code: "invalid_curriculum", reason: "validation_failed" });
  });

  it("hashes content consistently despite key order and top-level metadata", async () => {
    const draft = curriculum();
    const reordered = Object.fromEntries(Object.entries(draft).reverse()) as CurriculumDraft;
    reordered.outcomes = draft.outcomes.map((outcome) =>
      Object.fromEntries(Object.entries(outcome).reverse()) as typeof outcome);
    reordered.id = ids.missing;
    reordered.courseId = ids.missing;
    reordered.conversationId = ids.missing;
    reordered.revision = 42;
    reordered.updatedAt = "2026-10-25T12:00:00.000Z";
    const digest = await curriculumDigest(draft);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await curriculumDigest(reordered)).toBe(digest);
  });

  it("preserves meaningful array order in the digest", async () => {
    const draft = curriculum();
    const digest = await curriculumDigest(draft);
    draft.modules.reverse();
    expect(await curriculumDigest(draft)).not.toBe(digest);
  });
});
