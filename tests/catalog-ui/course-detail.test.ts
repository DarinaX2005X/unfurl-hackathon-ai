import { describe, expect, it, vi } from "vitest";
import type { CatalogPort } from "../../src/application/catalog-port";
import type { ServiceResult } from "../../src/application/ports";
import type { ApiErrorCode, AccessibleCourseDetail, CourseDetailPublic } from "../../src/domain";
import type { CourseDetailResult } from "../../src/domain/catalog";
import { courseDetailAuthorityKey, CourseDetailRequest, loadCourseDetail, type CourseDetailLoadResult } from "../../src/features/catalog/course-detail";
import { curriculum, ids } from "../domain/fixtures";
import { catalogService, course, deferred } from "./fixtures";

function publicCourse(): CourseDetailPublic {
  const plan = curriculum();
  return { ...course(), assumedKnowledge: plan.assumedKnowledge, outcomes: plan.outcomes, modules: plan.modules };
}
function accessible(access: AccessibleCourseDetail["access"] = "public"): AccessibleCourseDetail {
  return { course: publicCourse(), version: { id: ids.draft, number: 3 }, access, enrollmentId: null };
}
function detailService(getBySlug: CatalogPort["getBySlug"]): CatalogPort { return catalogService({ getBySlug }); }
function failure<T>(code: ApiErrorCode): ServiceResult<T> {
  return { ok: false, error: { error: { code, messageKey: `course.${code}`, retryable: code === "service_unavailable", requestId: ids.request } } };
}

describe("course detail boundary", () => {
  it("keys detail state by account epoch and actor, including anonymous authority", () => {
    expect(courseDetailAuthorityKey(3, "ready", ids.actor)).toBe(`3:${ids.actor}`);
    expect(courseDetailAuthorityKey(3, "ready", null)).toBe("3:anonymous");
    expect(courseDetailAuthorityKey(4, "loading", ids.actor)).toBe("4:loading");
  });

  it("requests the exact slug and abort signal, then preserves the access projection", async () => {
    const detail: CourseDetailResult = { kind: "ready", detail: accessible() };
    const getBySlug = vi.fn().mockResolvedValue({ ok: true, data: detail });
    const abort = new AbortController();
    expect(await loadCourseDetail(detailService(getBySlug), { slug: "model-evaluation" }, abort.signal)).toEqual(detail);
    expect(getBySlug).toHaveBeenCalledExactlyOnceWith("model-evaluation", abort.signal);
  });

  it("wraps an exact-version share result without changing its access", async () => {
    const detail = accessible("share");
    const resolveShare = vi.fn().mockResolvedValue({ ok: true, data: detail });
    const abort = new AbortController();
    expect(await loadCourseDetail(catalogService({ resolveShare }), { shareToken: "token" }, abort.signal)).toEqual({ kind: "ready", detail });
    expect(resolveShare).toHaveBeenCalledExactlyOnceWith("token", abort.signal);
  });

  it.each(["not_found", "forbidden", "unauthenticated"] as const)("maps %s to the same unavailable result without exposing detail", async (code) => {
    const getBySlug = vi.fn().mockResolvedValue(failure<CourseDetailResult>(code));
    const result = await loadCourseDetail(detailService(getBySlug), { slug: "private-course" }, new AbortController().signal);
    expect(result).toEqual({ kind: "unavailable" });
    expect(result).not.toHaveProperty("detail");
    expect(result).not.toHaveProperty("error");
  });

  it("keeps service failure distinct from absent or inaccessible content", async () => {
    const getBySlug = vi.fn().mockResolvedValue(failure<CourseDetailResult>("service_unavailable"));
    expect(await loadCourseDetail(detailService(getBySlug), { slug: "model-evaluation" }, new AbortController().signal)).toEqual({ kind: "error" });
  });

  it("contains transport rejection without exposing the exception or creating course data", async () => {
    const getBySlug = vi.fn().mockRejectedValue(new Error("Internal transport diagnostic"));
    expect(await loadCourseDetail(detailService(getBySlug), { slug: "model-evaluation" }, new AbortController().signal)).toEqual({ kind: "error" });
  });

  it("rejects an already aborted load before requesting the service", async () => {
    const getBySlug = vi.fn();
    const abort = new AbortController();
    abort.abort();
    await expect(loadCourseDetail(detailService(getBySlug), { slug: "model-evaluation" }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(getBySlug).not.toHaveBeenCalled();
  });

  it("rejects a late response after abort even when the service disregards the signal", async () => {
    const response = deferred<ServiceResult<CourseDetailResult>>();
    const abort = new AbortController();
    const pending = loadCourseDetail(detailService(() => response.promise), { slug: "model-evaluation" }, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    response.resolve({ ok: true, data: { kind: "ready", detail: accessible() } });
    await rejected;
  });

  it("cannot publish a pending owner result after the account-scoped request is disposed", async () => {
    const oldResponse = deferred<ServiceResult<CourseDetailResult>>();
    let current: CourseDetailLoadResult | { kind: "loading" } = { kind: "loading" };
    const oldActor = new CourseDetailRequest(detailService(() => oldResponse.promise), { slug: "model-evaluation" }, (result) => { current = result; });
    const oldPending = oldActor.start();
    oldActor.dispose();
    const anonymous = new CourseDetailRequest(detailService(async () => ({ ok: true, data: { kind: "ready", detail: accessible("public") } })),
      { slug: "model-evaluation" }, (result) => { current = result; });
    await anonymous.start();
    oldResponse.resolve({ ok: true, data: { kind: "ready", detail: accessible("owner") } });
    await oldPending;
    expect(current).toMatchObject({ kind: "ready", detail: { access: "public" } });
  });
});
