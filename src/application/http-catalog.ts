import { z } from "zod";
import { AccessibleCourseDetailSchema } from "../domain/course";
import { ApiErrorSchema, type ApiError } from "../domain/errors";
import {
  CatalogQuerySchema, CourseDetailResultSchema, CourseSummaryPageSchema, CreateShareInputSchema,
  EnrollmentInputSchema, LibraryCoursePageSchema, LibraryQuerySchema, ShareCreatedSchema, ShareListSchema,
} from "../domain/catalog";
import { EnrollmentReceiptSchema } from "../domain/learning";
import type { ServiceResult } from "./ports";
import type { CatalogPort } from "./catalog-port";

function unavailable(requestId: string): ApiError {
  return { error: { code: "service_unavailable", messageKey: "catalog.unavailable", retryable: true, requestId } };
}
function segment(value: string): string { return encodeURIComponent(value); }
function search(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function createHttpCatalog(fetcher: typeof fetch = (...args) => fetch(...args)): CatalogPort {
  async function request<T>(path: string, method: "GET" | "POST" | "DELETE", schema: z.ZodType<T>, options: {
    body?: unknown; key?: string; signal?: AbortSignal;
  } = {}): Promise<ServiceResult<T>> {
    options.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    try {
      const response = await fetcher(path, {
        method, credentials: "same-origin", cache: "no-store",
        headers: {
          Accept: "application/json", "X-Request-Id": requestId,
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.status === 204) return schema.safeParse(null).success
        ? { ok: true, data: null as T }
        : { ok: false, error: unavailable(requestId) };
      const payload: unknown = await response.json();
      options.signal?.throwIfAborted();
      if (!response.ok) {
        const error = ApiErrorSchema.safeParse(payload);
        return { ok: false, error: error.success ? error.data : unavailable(requestId) };
      }
      const parsed = z.object({ data: schema }).strict().safeParse(payload);
      return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, error: unavailable(requestId) };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { ok: false, error: unavailable(requestId) };
    }
  }

  return {
    listPublic(query, signal) {
      const parsed = CatalogQuerySchema.safeParse(query);
      if (!parsed.success) return Promise.resolve({ ok: false, error: unavailable(crypto.randomUUID()) });
      return request(`/api/v1/catalog${search(parsed.data)}`, "GET", CourseSummaryPageSchema, { ...(signal ? { signal } : {}) });
    },
    getBySlug(slug, signal) { return request(`/api/v1/courses/by-slug/${segment(slug)}`, "GET", CourseDetailResultSchema, { ...(signal ? { signal } : {}) }); },
    getCourse(courseId, versionId, signal) {
      return request(`/api/v1/courses/${segment(courseId)}${search({ version: versionId })}`, "GET", CourseDetailResultSchema, { ...(signal ? { signal } : {}) });
    },
    resolveShare(token, signal) { return request(`/api/v1/shares/${segment(token)}`, "GET", AccessibleCourseDetailSchema, { ...(signal ? { signal } : {}) }); },
    listLibrary(query, signal) {
      const parsed = LibraryQuerySchema.safeParse(query);
      if (!parsed.success) return Promise.resolve({ ok: false, error: unavailable(crypto.randomUUID()) });
      return request(`/api/v1/me/library${search(parsed.data)}`, "GET", LibraryCoursePageSchema, { ...(signal ? { signal } : {}) });
    },
    createEnrollment(courseId, input, idempotencyKey, signal) {
      const body = EnrollmentInputSchema.parse(input);
      return request(`/api/v1/courses/${segment(courseId)}/enrollments`, "POST", EnrollmentReceiptSchema, { body, key: idempotencyKey, ...(signal ? { signal } : {}) });
    },
    listShares(courseId, signal) { return request(`/api/v1/courses/${segment(courseId)}/shares`, "GET", ShareListSchema, { ...(signal ? { signal } : {}) }); },
    createShare(courseId, input, idempotencyKey, signal) {
      const body = CreateShareInputSchema.parse(input);
      return request(`/api/v1/courses/${segment(courseId)}/shares`, "POST", ShareCreatedSchema, { body, key: idempotencyKey, ...(signal ? { signal } : {}) });
    },
    revokeShare(courseId, shareId, signal) {
      return request(`/api/v1/courses/${segment(courseId)}/shares/${segment(shareId)}`, "DELETE", z.null(), { body: {}, ...(signal ? { signal } : {}) });
    },
  };
}

export const httpCatalog: CatalogPort = createHttpCatalog();
