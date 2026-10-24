import { describe, expect, it, vi } from "vitest";
import { localApplication } from "../../src/application/local-adapter";
import type { ApplicationPort, ServiceResult } from "../../src/application/ports";
import type { ApiErrorCode, CourseDetailPublic } from "../../src/domain";
import { loadCourseDetail } from "../../src/features/catalog/course-detail";
import { curriculum, ids } from "../domain/fixtures";
import { course, deferred } from "./fixtures";

function publicDetail(): CourseDetailPublic {
  const plan = curriculum();
  return { ...course(), assumedKnowledge: plan.assumedKnowledge, outcomes: plan.outcomes, modules: plan.modules };
}
function detailService(getPublicCourse: ApplicationPort["getPublicCourse"]): ApplicationPort { return { ...localApplication, getPublicCourse }; }
function failure(code: ApiErrorCode): ServiceResult<CourseDetailPublic> {
  return { ok: false, error: { error: { code, messageKey: `course.${code}`, retryable: code === "service_unavailable", requestId: ids.request } } };
}

describe("public course detail boundary", () => {
  it("requests the exact slug and abort signal, then returns only the supplied public detail", async () => {
    const detail = publicDetail();
    const getPublicCourse = vi.fn().mockResolvedValue({ ok: true, data: detail });
    const abort = new AbortController();
    expect(await loadCourseDetail(detailService(getPublicCourse), "model-evaluation", abort.signal)).toEqual({ kind: "ready", course: detail });
    expect(getPublicCourse).toHaveBeenCalledExactlyOnceWith("model-evaluation", abort.signal);
  });

  it.each(["not_found", "forbidden", "unauthenticated"] as const)("maps %s to the same unavailable result without exposing detail", async (code) => {
    const getPublicCourse = vi.fn().mockResolvedValue(failure(code));
    const result = await loadCourseDetail(detailService(getPublicCourse), "private-course", new AbortController().signal);
    expect(result).toEqual({ kind: "unavailable" });
    expect(result).not.toHaveProperty("course");
    expect(result).not.toHaveProperty("error");
  });

  it("keeps service failure distinct from absent or inaccessible content", async () => {
    const getPublicCourse = vi.fn().mockResolvedValue(failure("service_unavailable"));
    expect(await loadCourseDetail(detailService(getPublicCourse), "model-evaluation", new AbortController().signal)).toEqual({ kind: "error" });
  });

  it("contains transport rejection without exposing the exception or creating course data", async () => {
    const getPublicCourse = vi.fn().mockRejectedValue(new Error("Internal transport diagnostic"));
    expect(await loadCourseDetail(detailService(getPublicCourse), "model-evaluation", new AbortController().signal)).toEqual({ kind: "error" });
  });

  it("rejects an already aborted load before requesting the service", async () => {
    const getPublicCourse = vi.fn();
    const abort = new AbortController();
    abort.abort();
    await expect(loadCourseDetail(detailService(getPublicCourse), "model-evaluation", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(getPublicCourse).not.toHaveBeenCalled();
  });

  it("rejects a late response after abort even when the service disregards the signal", async () => {
    const response = deferred<ServiceResult<CourseDetailPublic>>();
    const abort = new AbortController();
    const pending = loadCourseDetail(detailService(() => response.promise), "model-evaluation", abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    response.resolve({ ok: true, data: publicDetail() });
    await rejected;
  });
});
