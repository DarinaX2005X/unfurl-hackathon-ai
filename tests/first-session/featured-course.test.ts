import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import type { AccessibleCourseDetail } from "@/domain/course";
import type { CourseDetailResult } from "@/domain/catalog";
import { resolveFeaturedCourse } from "@/server/catalog/featured";
import { course } from "../catalog-ui/fixtures";
import { curriculum, ids } from "../domain/fixtures";

const env = { FEATURED_AI_COURSE_ID: ids.course, FEATURED_AI_COURSE_VERSION_ID: ids.draft };

function ready(overrides: {
  courseId?: string;
  versionId?: string;
  access?: AccessibleCourseDetail["access"];
  visibility?: AccessibleCourseDetail["course"]["visibility"];
} = {}): CourseDetailResult {
  const plan = curriculum();
  return { kind: "ready", detail: {
    course: {
      ...course({ id: overrides.courseId ?? ids.course, visibility: overrides.visibility ?? "public" }),
      assumedKnowledge: plan.assumedKnowledge,
      outcomes: plan.outcomes,
      modules: plan.modules,
    },
    version: { id: overrides.versionId ?? ids.draft, number: 1 },
    access: overrides.access ?? "public",
    enrollmentId: null,
  } };
}

describe("featured course resolution", () => {
  it("stays unavailable when either exact identifier is absent or malformed", async () => {
    const loadCourse = vi.fn();
    await expect(resolveFeaturedCourse({ env: {}, loadCourse })).resolves.toEqual({ kind: "unavailable" });
    await expect(resolveFeaturedCourse({ env: { ...env, FEATURED_AI_COURSE_VERSION_ID: "latest" }, loadCourse })).resolves.toEqual({ kind: "unavailable" });
    expect(loadCourse).not.toHaveBeenCalled();
  });

  it("returns the configured identity only for the same public published projection", async () => {
    const loadCourse = vi.fn().mockResolvedValue(ready());
    await expect(resolveFeaturedCourse({ env, loadCourse })).resolves.toEqual({
      kind: "ready", courseId: ids.course, courseVersionId: ids.draft, slug: "model-evaluation",
    });
    expect(loadCourse).toHaveBeenCalledExactlyOnceWith(ids.course, ids.draft);
  });

  it.each([
    ["another course", ready({ courseId: ids.sample })],
    ["another version", ready({ versionId: ids.sample })],
    ["owner access", ready({ access: "owner" })],
    ["non-public visibility", ready({ visibility: "private" })],
  ])("rejects a ready result for %s", async (_case, result) => {
    await expect(resolveFeaturedCourse({ env, loadCourse: async () => result })).resolves.toEqual({ kind: "unavailable" });
  });

  it("contains an unpublished, missing, or failed catalog lookup", async () => {
    const loadCourse = vi.fn().mockRejectedValue(new Error("catalog detail must not escape"));
    await expect(resolveFeaturedCourse({ env, loadCourse })).resolves.toEqual({ kind: "unavailable" });
  });
});
