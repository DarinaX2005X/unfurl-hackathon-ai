import "server-only";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { IdSchema } from "@/domain/common";
import { ActivityActionRequestSchema, SaveActivityInputSchema, SubmitActivityAttemptSchema } from "@/domain/activity";
import { ActionRetryInputSchema, RouteRevisionInputSchema, StartActivityInputSchema, RevisitInputSchema,
  LearningContextQuerySchema, HintInputSchema, EvaluationRevisionInputSchema, SupportRequestSchema, SupportResponseInputSchema, AssessmentReviewInputSchema } from "@/application/learning-port";
import { requireActor } from "@/server/auth/session";
import { assertSameOrigin, failure, readInput, success } from "@/server/auth/http";
import { invalidLearningFields } from "./actions";
import { learningService } from "./service";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidLearningFields(result.error.issues);
  return result.data;
}
const id = (value: unknown) => parse(IdSchema, value);
async function mutationInput<T>(request: NextRequest, schema: z.ZodType<T>) {
  assertSameOrigin(request);
  const actor = await requireActor();
  const key = id(request.headers.get("Idempotency-Key"));
  const raw = await readInput(request, z.unknown(), { maxBytes: 140 * 1024 });
  return { actor, command: { key, body: parse(schema, raw) } };
}
export async function loadSessionRoute(request: NextRequest, enrollmentId: string) {
  try { return success(await learningService.loadSession(await requireActor(), id(enrollmentId))); }
  catch (error) { return failure(error, request); }
}
export async function requestFreshAssessmentRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, RouteRevisionInputSchema);
    const result = await learningService.requestFreshAssessment(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function loadContextRoute(request: NextRequest, enrollmentId: string) {
  try {
    const actor = await requireActor();
    const parameters = Object.fromEntries(request.nextUrl.searchParams);
    const query = parse(LearningContextQuerySchema, { ...parameters,
      ...(parameters.limit !== undefined ? { limit: Number(parameters.limit) } : {}) });
    return success(await learningService.loadContext(actor, id(enrollmentId), query));
  } catch (error) { return failure(error, request); }
}
export async function getEvaluationRoute(request: NextRequest, attemptId: string) {
  try { return success(await learningService.getEvaluation(await requireActor(), id(attemptId))); }
  catch (error) { return failure(error, request); }
}
export async function submitAttemptRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, SubmitActivityAttemptSchema);
    const result = await learningService.submitAttempt(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function requestHintRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, HintInputSchema);
    const result = await learningService.requestHint(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function revealAnswerRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, StartActivityInputSchema);
    const result = await learningService.revealAnswer(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function acknowledgeFeedbackRoute(request: NextRequest, attemptId: string) {
  try {
    const { actor, command } = await mutationInput(request, EvaluationRevisionInputSchema);
    const result = await learningService.acknowledgeFeedback(actor, id(attemptId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function requestSupportRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, SupportRequestSchema);
    const result = await learningService.requestSupport(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function respondToSupportRoute(request: NextRequest, enrollmentId: string, offerId: string) {
  try {
    const { actor, command } = await mutationInput(request, SupportResponseInputSchema);
    const result = await learningService.respondToSupport(actor, id(enrollmentId), id(offerId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function returnFromSupportRoute(request: NextRequest, enrollmentId: string, offerId: string) {
  try {
    const { actor, command } = await mutationInput(request, RouteRevisionInputSchema);
    const result = await learningService.returnFromSupport(actor, id(enrollmentId), id(offerId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function retryEvaluationRoute(request: NextRequest, attemptId: string) {
  try {
    const { actor, command } = await mutationInput(request, EvaluationRevisionInputSchema);
    const result = await learningService.retryEvaluation(actor, id(attemptId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function requestReviewRoute(request: NextRequest, attemptId: string) {
  try {
    const { actor, command } = await mutationInput(request, AssessmentReviewInputSchema);
    const result = await learningService.requestReview(actor, id(attemptId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function retryReviewRoute(request: NextRequest, attemptId: string, reviewId: string) {
  try {
    const { actor, command } = await mutationInput(request, EvaluationRevisionInputSchema);
    const result = await learningService.retryReview(actor, id(attemptId), id(reviewId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function getActivityRoute(request: NextRequest, activityId: string) {
  try { return success(await learningService.getActivity(await requireActor(), id(activityId))); }
  catch (error) { return failure(error, request); }
}
export async function startActivityRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, StartActivityInputSchema);
    const result = await learningService.startActivity(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function saveInputRoute(request: NextRequest, activityId: string) {
  try {
    const { actor, command } = await mutationInput(request, SaveActivityInputSchema);
    const result = await learningService.saveInput(actor, id(activityId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function dispatchActionRoute(request: NextRequest, activityId: string) {
  try {
    const { actor, command } = await mutationInput(request, ActivityActionRequestSchema);
    const result = await learningService.dispatchAction(actor, id(activityId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function retryActionRoute(request: NextRequest, activityId: string, receiptId: string) {
  try {
    const { actor, command } = await mutationInput(request, ActionRetryInputSchema);
    const result = await learningService.retryAction(actor, id(activityId), id(receiptId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function advanceRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, RouteRevisionInputSchema);
    const result = await learningService.advance(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
export async function revisitRoute(request: NextRequest, enrollmentId: string) {
  try {
    const { actor, command } = await mutationInput(request, RevisitInputSchema);
    const result = await learningService.revisit(actor, id(enrollmentId), command);
    return success(result.data, result.status);
  } catch (error) { return failure(error, request); }
}
