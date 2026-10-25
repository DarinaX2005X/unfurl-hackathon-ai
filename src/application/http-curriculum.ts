import { z } from "zod";
import { CourseArtifactRefSchema } from "../domain/chat";
import { IdSchema } from "../domain/common";
import {
  ApproveCurriculumInputSchema,
  CourseLanguageRequestResultSchema,
  CurriculumApprovalResultSchema,
  CurriculumAuthoringSnapshotSchema,
  CurriculumPatchResultSchema,
  EditCourseMetadataInputSchema,
  PatchCurriculumInputSchema,
  RequestCourseLanguageInputSchema,
} from "../domain/curriculum-authoring";
import { ApiErrorSchema, type ApiError } from "../domain/errors";
import type { CurriculumPort, CurriculumMutationOptions } from "./curriculum-port";
import type { ServiceResult } from "./ports";

function failure<T>(requestId: string, invalid = false): ServiceResult<T> {
  return { ok: false, error: { error: {
    code: invalid ? "invalid_input" : "service_unavailable",
    messageKey: invalid ? "curriculum.invalidInput" : "curriculum.unavailable",
    retryable: !invalid,
    requestId,
  } } };
}

const segment = (value: string) => encodeURIComponent(value);

export function createHttpCurriculum(fetcher: typeof fetch = (...args) => fetch(...args)): CurriculumPort {
  async function request<T>(
    ids: string[],
    path: string,
    method: "GET" | "POST" | "PATCH",
    schema: z.ZodType<T>,
    options: { body?: unknown; inputSchema?: z.ZodType; key?: string; signal?: AbortSignal } = {},
    accepts: (data: T) => boolean = () => true,
  ): Promise<ServiceResult<T>> {
    options.signal?.throwIfAborted();
    const validKey = options.key === undefined || IdSchema.safeParse(options.key).success;
    const requestId = validKey && options.key ? options.key : crypto.randomUUID();
    if (ids.some((id) => !IdSchema.safeParse(id).success) || !validKey || (method !== "GET" && options.key === undefined)) {
      return failure(requestId, true);
    }
    const parsedInput = options.inputSchema?.safeParse(options.body);
    if (parsedInput && !parsedInput.success) return failure(requestId, true);
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "X-Request-Id": requestId,
          ...(method === "GET" ? {} : {
            "Content-Type": "application/json",
            "Idempotency-Key": options.key!,
          }),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(parsedInput?.data ?? options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      const payload: unknown = await response.json();
      options.signal?.throwIfAborted();
      if (!response.ok) {
        const error = ApiErrorSchema.safeParse(payload);
        return error.success ? { ok: false, error: error.data } : failure(requestId);
      }
      const parsed = z.object({ data: schema }).strict().safeParse(payload);
      return parsed.success && accepts(parsed.data.data)
        ? { ok: true, data: parsed.data.data }
        : failure(requestId);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return failure(requestId);
    }
  }

  const mutation = <T>(
    ids: string[],
    path: string,
    inputSchema: z.ZodType,
    resultSchema: z.ZodType<T>,
    body: unknown,
    options: CurriculumMutationOptions,
    accepts: (data: T) => boolean,
  ) => request(ids, path, "POST", resultSchema, {
    inputSchema,
    body,
    key: options.idempotencyKey,
    ...(options.signal ? { signal: options.signal } : {}),
  }, accepts);

  return {
    getCurriculum(draftId, signal) {
      return request([draftId], `/api/v1/curricula/${segment(draftId)}`, "GET", CurriculumAuthoringSnapshotSchema,
        { ...(signal ? { signal } : {}) }, (data) => data.draft.id === draftId);
    },
    patchCurriculum(draftId, input, options) {
      return request([draftId], `/api/v1/curricula/${segment(draftId)}`, "PATCH", CurriculumPatchResultSchema, {
        inputSchema: PatchCurriculumInputSchema,
        body: input,
        key: options.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      }, (data) => "status" in data ? data.artifact.curriculum?.id === draftId : data.draft.id === draftId);
    },
    approveCurriculum(draftId, input, options) {
      return mutation([draftId], `/api/v1/curricula/${segment(draftId)}/approve`, ApproveCurriculumInputSchema,
        CurriculumApprovalResultSchema, input, options, (data) => data.approval.draftId === draftId);
    },
    editCourseMetadata(courseId, input, options) {
      return request([courseId], `/api/v1/courses/${segment(courseId)}/metadata`, "PATCH", CourseArtifactRefSchema, {
        inputSchema: EditCourseMetadataInputSchema,
        body: input,
        key: options.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      }, (data) => data.courseId === courseId);
    },
    requestCourseLanguage(courseId, input, options) {
      return mutation([courseId], `/api/v1/courses/${segment(courseId)}/language-revisions`, RequestCourseLanguageInputSchema,
        CourseLanguageRequestResultSchema, input, options, (data) => data.artifact.courseId === courseId);
    },
  };
}

export const httpCurriculum: CurriculumPort = createHttpCurriculum();

export type CurriculumHttpError = ApiError;
