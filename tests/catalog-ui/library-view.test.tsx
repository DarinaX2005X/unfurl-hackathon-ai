import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryCourseItem } from "../../src/domain/catalog";
import { LibraryCollection } from "../../src/features/library/LibraryCollection";
import type { LibraryState } from "../../src/features/library/library-controller";
import { course } from "./fixtures";
import { ids, timestamp } from "../domain/fixtures";

const enrollmentId = "00000000-0000-4000-8000-000000000097";
const ownedGroup: LibraryCourseItem = { courseId: ids.course, owned: {
  id: ids.course, slug: "model-evaluation", title: "Created course", summary: "Compare evidence from training and validation data.",
  contentLanguage: "en", visibility: "public", currentReadyVersionId: ids.draft, publishedVersionId: ids.draft,
  updatedAt: timestamp, revision: 1, cover: course().cover, latestVersion: { id: ids.draft, number: 1, state: "ready" }, conversationId: null,
}, enrollments: [] };
const learningCourse = course({ id: ids.missing, slug: "reading-japanese", title: "Already learning" });
const enrolledGroup: LibraryCourseItem = { courseId: learningCourse.id, owned: null, enrollments: [{ course: learningCourse,
  version: { id: ids.source, number: 2 }, enrollment: { id: enrollmentId, learnerId: ids.actor, courseId: learningCourse.id,
    courseVersionId: ids.source, status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null,
    createdAt: timestamp, lastStudiedAt: timestamp } }] };

function state(overrides: Partial<LibraryState>): LibraryState {
  return { status: "ready", items: [], nextCursor: null, refreshing: false, loadingMore: false, pageError: null, ...overrides };
}
function render(value: LibraryState, filtered = false, view: "all" | "courses" | "in_progress" = "all") {
  return renderToStaticMarkup(<LibraryCollection state={value} view={view} filtered={filtered} onRetry={() => {}}
    onResetFilters={() => {}} onShowAll={() => {}} onLoadMore={() => {}} />);
}

describe("library state presentation", () => {
  it("distinguishes failed, genuinely empty and filtered no-match states", () => {
    const error = render(state({ status: "error" }));
    const empty = render(state({}));
    const noMatch = render(state({}), true);
    expect(error).toContain("Your courses couldn’t be loaded");
    expect(empty).toContain("No courses in your library yet");
    expect(noMatch).toContain("No courses match your search");
    expect(noMatch).toContain("Reset filters");
    for (const html of [error, empty, noMatch]) expect(html).not.toMatch(/New draft|Rename draft|Delete draft|On this device|course_request/);
  });

  it("offers a real all-courses escape from an empty selected tab", () => {
    const created = render(state({}), false, "courses");
    const progress = render(state({}), false, "in_progress");
    expect(created).toContain("You haven’t created a course yet");
    expect(progress).toContain("No courses in progress yet");
    expect(created).toContain("Show all courses");
    expect(progress).toContain("Show all courses");
  });

  it("renders actual enrollments before owned courses with real continuation links and no fake progress", () => {
    const html = render(state({ items: [ownedGroup, enrolledGroup] }));
    expect(html.indexOf("Continue learning")).toBeLessThan(html.indexOf("Created by you"));
    expect(html).toContain(`/learn/${enrollmentId}`);
    expect(html).toContain("Continue course");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("% complete");
  });

  it("keeps already-loaded course actions available alongside a failed refresh", () => {
    const html = render(state({ status: "error", items: [ownedGroup] }));
    expect(html).toContain("Your library could not be refreshed");
    expect(html).toContain("View course");
    expect(html).toContain("/courses/model-evaluation");
  });

  it("shows pagination failure without hiding retained groups", () => {
    const html = render(state({ items: [ownedGroup], pageError: "The next courses couldn’t be loaded." }));
    expect(html).toContain("Some courses could not be loaded");
    expect(html).toContain("Retry loading more");
    expect(html).toContain("View course");
  });
});
