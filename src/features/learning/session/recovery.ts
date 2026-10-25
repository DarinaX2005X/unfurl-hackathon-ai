import { z } from "zod";
import { ActionRetryInputSchema, AssessmentReviewInputSchema, EvaluationRevisionInputSchema, HintInputSchema, RevisitInputSchema, RouteRevisionInputSchema, StartActivityInputSchema, SupportRequestSchema, SupportResponseInputSchema } from "@/application/learning-port";
import { IdSchema, RevisionSchema, type JsonValue } from "@/domain/common";
import {
  ActivityActionRequestSchema, ActivityResponseSchema, SaveActivityInputSchema,
  SubmitActivityAttemptSchema,
} from "@/domain/activity";

/** A tab's unsent work and mutation identities, never an authoritative course cache. */
export const RecoveryRecordSchema = z.object({
  version: z.literal(1), actorId: IdSchema, enrollmentId: IdSchema,
  lessonId: IdSchema.nullable(), taskId: IdSchema.nullable(), taskVersion: RevisionSchema.nullable(),
  response: ActivityResponseSchema.nullable(),
  baseInputRevision: z.number().int().nonnegative(),
  startKey: IdSchema,
  save: z.object({ key: IdSchema, activityId: IdSchema, body: SaveActivityInputSchema }).strict().nullable(),
  action: z.object({ key: IdSchema, activityId: IdSchema, body: ActivityActionRequestSchema }).strict().nullable(),
  attempt: z.object({ key: IdSchema, body: SubmitActivityAttemptSchema, accepted: z.boolean() }).strict().nullable(),
  acknowledgement: z.object({ key: IdSchema, attemptId: IdSchema, revision: RevisionSchema }).strict().nullable(),
  advance: z.object({ key: IdSchema, revision: RevisionSchema }).strict().nullable(),
  command: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hint"), key: IdSchema, body: HintInputSchema }).strict(),
    z.object({ kind: z.literal("reveal"), key: IdSchema, body: StartActivityInputSchema }).strict(),
    z.object({ kind: z.literal("revisit"), key: IdSchema, body: RevisitInputSchema }).strict(),
    z.object({ kind: z.literal("fresh_assessment"), key: IdSchema, body: RouteRevisionInputSchema }).strict(),
    z.object({ kind: z.literal("support"), key: IdSchema, body: SupportRequestSchema }).strict(),
    z.object({ kind: z.literal("support_response"), key: IdSchema, target: IdSchema, body: SupportResponseInputSchema }).strict(),
    z.object({ kind: z.literal("support_return"), key: IdSchema, target: IdSchema, body: RouteRevisionInputSchema }).strict(),
    z.object({ kind: z.literal("review"), key: IdSchema, target: IdSchema, body: AssessmentReviewInputSchema }).strict(),
    z.object({ kind: z.literal("review_retry"), key: IdSchema, target: IdSchema, reviewId: IdSchema, body: EvaluationRevisionInputSchema }).strict(),
    z.object({ kind: z.literal("evaluation_retry"), key: IdSchema, target: IdSchema, body: EvaluationRevisionInputSchema }).strict(),
    z.object({ kind: z.literal("action_retry"), key: IdSchema, target: IdSchema, receiptId: IdSchema, body: ActionRetryInputSchema }).strict(),
  ]).nullable().default(null),
}).strict();

export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;
export type RecoveryCommand = NonNullable<RecoveryRecord["command"]>;
export interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function recoveryKey(actorId: string, enrollmentId: string, lessonId: string, taskId: string | null): string {
  return `unfurl.learning.recovery.v1:${actorId}:${enrollmentId}:${lessonId}:${taskId ?? "reading"}`;
}

export function readRecovery(storage: RecoveryStorage | null, key: string): RecoveryRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 600_000) return null;
    const result = RecoveryRecordSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}

export function cloneResponse(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function browserRecoveryStorage(): RecoveryStorage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}
