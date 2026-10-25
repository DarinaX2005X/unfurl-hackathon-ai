import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { ActivityActionRequestSchema, SaveActivityInputSchema, SubmitActivityAttemptSchema } from "@/domain/activity";
import { ApiErrorSchema } from "@/domain/errors";
import * as contract from "./learning-port";
import type { LearningPort, MutationOptions } from "./learning-port";
import type { ServiceResult } from "./ports";

function failed<T>(requestId: string, invalid = false): ServiceResult<T> {
  return { ok: false, error: { error: { code: invalid ? "invalid_input" : "service_unavailable",
    messageKey: invalid ? "learning.invalidInput" : "learning.unavailable", retryable: !invalid, requestId } } };
}

/** Stable caller keys survive network retry; this adapter does not replay or cache mutations. */
export function createHttpLearning(fetcher: typeof fetch = (...args) => fetch(...args)): LearningPort {
  async function request<T>(ids: string[], path: string, method: "GET" | "POST" | "PATCH", schema: z.ZodType<T>,
    options: { signal?: AbortSignal; key?: string; body?: unknown; inputSchema?: z.ZodType } = {},
    accepts: (data: T) => boolean = () => true): Promise<ServiceResult<T>> {
    options.signal?.throwIfAborted();
    const validKey = options.key !== undefined && IdSchema.safeParse(options.key).success;
    const requestId = validKey ? options.key! : crypto.randomUUID();
    if (ids.some((id) => !IdSchema.safeParse(id).success) || (method !== "GET" && !validKey)) return failed(requestId, true);
    const parsed = options.inputSchema?.safeParse(options.body);
    if (parsed && !parsed.success) return failed(requestId, true);
    try {
      const response = await fetcher(`/api/v1${path}`, { method, credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "X-Request-Id": requestId,
          ...(method === "GET" ? {} : { "Content-Type": "application/json", "Idempotency-Key": options.key! }) },
        ...(method === "GET" ? {} : { body: JSON.stringify(parsed?.data ?? options.body) }),
        ...(options.signal ? { signal: options.signal } : {}) });
      options.signal?.throwIfAborted();
      const value: unknown = await response.json();
      options.signal?.throwIfAborted();
      if (!response.ok) {
        const error = ApiErrorSchema.safeParse(value);
        return error.success ? { ok: false, error: error.data } : failed(requestId);
      }
      const payload = z.object({ data: schema }).strict().safeParse(value);
      return payload.success && accepts(payload.data.data) ? { ok: true, data: payload.data.data } : failed(requestId);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return failed(requestId);
    }
  }
  const mutation = <T>(ids: string[], path: string, method: "POST" | "PATCH", inputSchema: z.ZodType,
    resultSchema: z.ZodType<T>, body: unknown, options: MutationOptions, accepts?: (data: T) => boolean) =>
    request(ids, path, method, resultSchema, { inputSchema, body, key: options.idempotencyKey,
      ...(options.signal ? { signal: options.signal } : {}) }, accepts);
  const readOptions = (signal?: AbortSignal) => signal ? { signal } : {};
  return {
    loadContext: (id, query = {}, signal) => {
      signal?.throwIfAborted();
      const parsed = contract.LearningContextQuerySchema.safeParse(query);
      if (!parsed.success) return Promise.resolve(failed(crypto.randomUUID(), true));
      const params = new URLSearchParams();
      if (parsed.data.cursor) params.set("cursor", parsed.data.cursor);
      if (parsed.data.limit) params.set("limit", String(parsed.data.limit));
      return request([id], `/enrollments/${id}/context${params.size ? `?${params}` : ""}`, "GET", contract.LearningContextSchema, readOptions(signal), (data) => data.enrollmentId === id);
    },
    loadSession: (id, signal) => request([id], `/enrollments/${id}/session`, "GET", contract.LearningSessionSchema, readOptions(signal), (data) => data.enrollment.id === id),
    startActivity: (id, input, options) => mutation([id], `/enrollments/${id}/activity-sessions`, "POST", contract.StartActivityInputSchema, contract.ActivityStateSchema, input, options,
      (data) => data.activity.enrollmentId === id && data.activity.taskId === input.taskId && data.activity.taskVersion === input.taskVersion),
    getActivity: (id, signal) => request([id], `/activity-sessions/${id}`, "GET", contract.ActivityStateSchema, readOptions(signal), (data) => data.activity.id === id),
    saveInput: (id, input, options) => mutation([id], `/activity-sessions/${id}/input`, "PATCH", SaveActivityInputSchema, contract.ActivityStateSchema, input, options, (data) => data.activity.id === id),
    dispatchAction: (id, input, options) => mutation([id], `/activity-sessions/${id}/actions`, "POST", ActivityActionRequestSchema, contract.ActivityActionResultSchema, input, options,
      (data) => data.activity.id === id && data.receipt.clientActionId === input.clientActionId),
    retryAction: (id, receiptId, input, options) => mutation([id, receiptId], `/activity-sessions/${id}/actions/${receiptId}/retry`, "POST", contract.ActionRetryInputSchema, contract.ActivityActionResultSchema, input, options,
      (data) => data.activity.id === id && data.receipt.id === receiptId),
    submitAttempt: (id, input, options) => mutation([id], `/enrollments/${id}/attempts`, "POST", SubmitActivityAttemptSchema, contract.AttemptReceiptSchema, input, options, (data) => data.route.enrollmentId === id),
    getEvaluation: (id, signal) => request([id], `/attempts/${id}/evaluation`, "GET", contract.EvaluationReceiptSchema, readOptions(signal), (data) => data.evaluation.attemptId === id),
    retryEvaluation: (id, input, options) => mutation([id], `/attempts/${id}/evaluation/retry`, "POST", contract.EvaluationRevisionInputSchema, contract.EvaluationReceiptSchema, input, options, (data) => data.evaluation.attemptId === id),
    requestHint: (id, input, options) => mutation([id], `/enrollments/${id}/hints`, "POST", contract.HintInputSchema, contract.AssistanceReceiptSchema, input, options),
    revealAnswer: (id, input, options) => mutation([id], `/enrollments/${id}/reveal`, "POST", contract.StartActivityInputSchema, contract.RevealReceiptSchema, input, options),
    acknowledgeFeedback: (id, input, options) => mutation([id], `/attempts/${id}/feedback-acknowledgements`, "POST", contract.EvaluationRevisionInputSchema, contract.FeedbackAcknowledgementSchema, input, options,
      (data) => data.attemptId === id && data.evaluationRevision === input.expectedEvaluationRevision),
    advance: (id, input, options) => mutation([id], `/enrollments/${id}/advance`, "POST", contract.RouteRevisionInputSchema, contract.LearningSessionSchema, input, options, (data) => data.enrollment.id === id),
    revisit: (id, input, options) => mutation([id], `/enrollments/${id}/revisit`, "POST", contract.RevisitInputSchema, contract.LearningSessionSchema, input, options, (data) => data.enrollment.id === id),
    requestFreshAssessment: (id, input, options) => mutation([id], `/enrollments/${id}/fresh-assessment`, "POST", contract.RouteRevisionInputSchema, contract.LearningSessionSchema, input, options, (data) => data.enrollment.id === id),
    requestSupport: (id, input, options) => mutation([id], `/enrollments/${id}/support-requests`, "POST", contract.SupportRequestSchema, contract.SupportProposalSchema, input, options, (data) => data.route.enrollmentId === id),
    respondToSupport: (id, offerId, input, options) => mutation([id, offerId], `/enrollments/${id}/support-offers/${offerId}/respond`, "POST", contract.SupportResponseInputSchema, contract.SupportResultSchema, input, options,
      (data) => data.enrollment.id === id && data.offer.id === offerId),
    returnFromSupport: (id, offerId, input, options) => mutation([id, offerId], `/enrollments/${id}/support-offers/${offerId}/return`, "POST", contract.RouteRevisionInputSchema, contract.SupportResultSchema, input, options,
      (data) => data.enrollment.id === id && data.offer.id === offerId),
    requestReview: (id, input, options) => mutation([id], `/attempts/${id}/review-requests`, "POST", contract.AssessmentReviewInputSchema, contract.ReviewReceiptSchema, input, options, (data) => data.review.attemptId === id),
    retryReview: (id, reviewId, input, options) => mutation([id, reviewId], `/attempts/${id}/review-requests/${reviewId}/retry`, "POST", contract.EvaluationRevisionInputSchema, contract.ReviewReceiptSchema, input, options,
      (data) => data.review.attemptId === id && data.review.id === reviewId),
  };
}
export const httpLearning: LearningPort = createHttpLearning();
