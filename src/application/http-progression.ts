import { z } from "zod";
import { IdSchema } from "../domain/common";
import { ApiErrorSchema, type ApiError } from "../domain/errors";
import { AccountProgressSchema } from "../domain/learning";
import {
  CourseVisibilityInputSchema,
  CourseVisibilityReceiptSchema,
  CourseVisibilityStateSchema,
} from "../domain/progression";
import type { ProgressionPort } from "./progression-port";
import type { ServiceResult } from "./ports";

function unavailable(requestId: string): ApiError {
  return { error: { code: "service_unavailable", messageKey: "progress.unavailable", retryable: true, requestId } };
}

function invalid(requestId: string): ApiError {
  return { error: { code: "invalid_input", messageKey: "progress.invalidInput", retryable: false, requestId } };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function createHttpProgression(fetcher: typeof fetch = (...args) => fetch(...args)): ProgressionPort {
  async function request<T>(
    path: string,
    method: "GET" | "PATCH",
    schema: z.ZodType<T>,
    options: { body?: unknown; key?: string; signal?: AbortSignal } = {},
  ): Promise<ServiceResult<T>> {
    options.signal?.throwIfAborted();
    const requestId = options.key && IdSchema.safeParse(options.key).success ? options.key : crypto.randomUUID();
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-Request-Id": requestId,
          ...(method === "PATCH" ? {
            "Content-Type": "application/json",
            "Idempotency-Key": options.key!,
          } : {}),
        },
        ...(method === "PATCH" ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
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
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { ok: false, error: unavailable(requestId) };
    }
  }

  return {
    getAccountProgress(signal) {
      return request("/api/v1/me/progress", "GET", AccountProgressSchema, signal ? { signal } : {});
    },
    getCourseVisibility(courseId, signal) {
      if (!IdSchema.safeParse(courseId).success) return Promise.resolve({ ok: false, error: invalid(crypto.randomUUID()) });
      return request(`/api/v1/courses/${segment(courseId)}/visibility`, "GET", CourseVisibilityStateSchema, signal ? { signal } : {});
    },
    setVisibility(courseId, input, options) {
      options.signal?.throwIfAborted();
      const body = CourseVisibilityInputSchema.safeParse(input);
      if (!IdSchema.safeParse(courseId).success || !IdSchema.safeParse(options.idempotencyKey).success || !body.success) {
        return Promise.resolve({ ok: false, error: invalid(crypto.randomUUID()) });
      }
      return request(`/api/v1/courses/${segment(courseId)}/visibility`, "PATCH", CourseVisibilityReceiptSchema, {
        body: body.data,
        key: options.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  };
}

export const httpProgression: ProgressionPort = createHttpProgression();
