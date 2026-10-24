import { describe, expect, it, vi } from "vitest";
import { editExistingCourseMetadata } from "../../src/features/creator/artifact-mutations";
import type { CourseArtifactRef } from "../../src/domain/chat";
import { curriculumDigest } from "../../src/domain/course";
import { curriculum, ids, timestamp } from "../domain/fixtures";

function artifact(): CourseArtifactRef {
  const draft = curriculum();
  return { courseId: ids.course, title: draft.title, summary: draft.goal, contentLanguage: "en", revision: 1, curriculum: draft,
    approval: null, approvalRequestedRevision: 1, readyVersionId: null, updatedAt: timestamp };
}

describe("metadata edits on existing course artifacts", () => {
  it("captures the original course and revision independently of a later selection", async () => {
    const original = artifact();
    let selectedCourseId: string = original.courseId;
    const other = { ...original, courseId: ids.sample, curriculum: null };
    const getCurrent = vi.fn((courseId: string) => courseId === original.courseId ? original : other);
    const values = { title: original.title, summary: "A revised description", contentLanguage: "en" };
    const edit = vi.fn(async () => { selectedCourseId = other.courseId; return { ...original, ...values, revision: 2 }; });
    const result = await editExistingCourseMetadata(original, values, getCurrent, edit);
    expect(selectedCourseId).toBe(other.courseId);
    expect(edit).toHaveBeenCalledWith({ ...values, courseId: original.courseId, expectedRevision: 1 });
    expect(result.courseId).toBe(original.courseId);
    expect(getCurrent.mock.calls.every(([courseId]) => courseId === original.courseId)).toBe(true);
  });

  it("rejects a delayed metadata acknowledgement after that course changed", async () => {
    const original = artifact();
    let current = original;
    const values = { title: original.title, summary: "A revised description", contentLanguage: "en" };
    await expect(editExistingCourseMetadata(original, values, () => current, async () => {
      current = { ...original, revision: 3 };
      return { ...original, ...values, revision: 2 };
    })).rejects.toThrow("not confirmed");
  });

  it.each(["title", "contentLanguage"] as const)("requires a new program revision and rejects stale approval after changing %s", async (field) => {
    const original = artifact();
    const receipt = { id: ids.approval, draftId: ids.draft, draftRevision: 1, contentDigest: await curriculumDigest(original.curriculum!), approvedBy: ids.actor, approvedAt: timestamp };
    original.approval = receipt;
    const values = { title: original.title, summary: original.summary, contentLanguage: original.contentLanguage, [field]: field === "title" ? "Changed title" : "ja" };
    const stale = { ...original, ...values, revision: 2 };
    await expect(editExistingCourseMetadata(original, values, () => original, async () => stale)).rejects.toThrow("updated revision");
    const revised = { ...stale, curriculum: { ...original.curriculum!, title: values.title, contentLanguage: values.contentLanguage, revision: 2 } };
    await expect(editExistingCourseMetadata(original, values, () => original, async () => revised)).rejects.toThrow();
    const confirmed = { ...revised, approval: null, approvalRequestedRevision: 2 };
    expect(await editExistingCourseMetadata(original, values, () => original, async () => confirmed)).toEqual(confirmed);
  });
});
