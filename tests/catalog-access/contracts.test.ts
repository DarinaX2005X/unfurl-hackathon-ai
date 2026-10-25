import { describe, expect, it } from "vitest";
import { CourseDetailResultSchema, LibraryCourseItemSchema } from "../../src/domain/catalog";

describe("catalog transport contracts", () => {
  it("keeps owned and pinned enrollment facets independent in one course group", () => {
    const courseId = crypto.randomUUID(), versionId = crypto.randomUUID(), enrollmentId = crypto.randomUUID();
    const value = LibraryCourseItemSchema.parse({
      courseId,
      owned: { id: courseId, slug: "current-draft", title: "Current draft", summary: "New owner metadata",
        contentLanguage: "en", visibility: "private", currentReadyVersionId: null, publishedVersionId: null,
        cover: null, latestVersion: { id: crypto.randomUUID(), number: 2, state: "building" },
        conversationId: crypto.randomUUID(), revision: 3, updatedAt: "2026-10-25T00:00:00.000Z" },
      enrollments: [{
        course: { id: courseId, slug: "current-draft", title: "Pinned v1", summary: "Immutable learner metadata",
          contentLanguage: "en", visibility: "private", moduleCount: 1, lessonCount: 1, estimatedStudyMinutes: 10,
          cover: { motifId: "science", alt: "Book" } },
        version: { id: versionId, number: 1 },
        enrollment: { id: enrollmentId, learnerId: crypto.randomUUID(), courseId, courseVersionId: versionId,
          status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null,
          createdAt: "2026-10-25T00:00:00.000Z", lastStudiedAt: null },
      }],
    });
    expect(value.owned?.title).toBe("Current draft");
    expect(value.enrollments[0]?.course.title).toBe("Pinned v1");
  });

  it("allows an owner-only unready detail without weakening ready public detail", () => {
    expect(CourseDetailResultSchema.parse({ kind: "owned_unready", course: {
      id: crypto.randomUUID(), slug: "draft", title: "Draft", summary: "Still building", contentLanguage: "en",
      visibility: "private", currentReadyVersionId: null, publishedVersionId: null, cover: null,
      latestVersion: null, conversationId: null, revision: 1, updatedAt: "2026-10-25T00:00:00.000Z",
    } }).kind).toBe("owned_unready");
  });
});
