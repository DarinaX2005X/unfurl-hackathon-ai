import "server-only";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { IdSchema } from "@/domain/common";
import { ActivityActionRequestSchema, SaveActivityInputSchema } from "@/domain/activity";
import { ActionRetryInputSchema, RouteRevisionInputSchema, StartActivityInputSchema, RevisitInputSchema } from "@/application/learning-port";
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
