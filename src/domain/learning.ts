import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, JsonValueSchema, RevisionSchema } from "./common";

export const LessonBlockSchema = z.discriminatedUnion("kind", [
  z.object({ id: IdSchema, kind: z.literal("explanation"), markdown: z.string(), sourceIds: z.array(IdSchema) }).strict(),
  z.object({ id: IdSchema, kind: z.literal("example"), title: z.string().min(1), content: z.string(), sourceIds: z.array(IdSchema) }).strict(),
  z.object({ id: IdSchema, kind: z.literal("task"), taskId: IdSchema }).strict(),
]);
export const LessonSchema = z.object({
  id: IdSchema, courseVersionId: IdSchema, moduleId: IdSchema,
  title: z.string().trim().min(1), outcomeIds: z.array(IdSchema).min(1),
  blocks: z.array(LessonBlockSchema), taskIds: z.array(IdSchema),
}).strict();

export const AttemptPayloadSchema = z.object({
  id: IdSchema, taskId: IdSchema, taskVersion: z.number().int().positive(),
  idempotencyKey: IdSchema, response: JsonValueSchema,
  assistance: z.enum(["independent", "hinted", "worked_example"]),
  hintIdsUsed: z.array(IdSchema), submittedAt: IsoDateTimeSchema,
}).strict();
export const AttemptSchema = AttemptPayloadSchema.extend({ enrollmentId: IdSchema }).strict();
export const SampleAttemptSchema = AttemptPayloadSchema.extend({ sampleSessionId: IdSchema }).strict();

export const EvaluationSchema = z.object({
  id: IdSchema, attemptId: IdSchema,
  status: z.enum(["evaluated", "uncertain", "pending", "unavailable"]),
  outcome: z.enum(["correct", "partial", "incorrect"]).nullable(),
  dimensions: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["met", "partial", "not_met", "uncertain"]),
    explanation: z.string(),
  }).strict()),
  feedback: z.object({
    explanation: z.string(), nextAction: z.enum(["continue", "revise", "clarify", "wait"]),
  }).strict(),
  awardedXp: z.number().int().nonnegative(),
}).strict().superRefine((evaluation, context) => {
  if (evaluation.status === "evaluated" && evaluation.outcome === null) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "An evaluated attempt needs an outcome" });
  }
  if (evaluation.status !== "evaluated" && (evaluation.outcome !== null || evaluation.awardedXp !== 0)) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "An unresolved evaluation cannot award XP or assert an outcome" });
  }
});
export const SampleEvaluationSchema = EvaluationSchema.refine((evaluation) => evaluation.awardedXp === 0, {
  path: ["awardedXp"], message: "Practice samples do not award account XP",
});

export const EnrollmentSchema = z.object({
  id: IdSchema, learnerId: IdSchema, courseId: IdSchema, courseVersionId: IdSchema,
  status: z.enum(["active", "completed", "archived"]),
  routeRevision: RevisionSchema,
  currentLessonId: IdSchema.nullable(), currentTaskId: IdSchema.nullable(),
  createdAt: IsoDateTimeSchema, lastStudiedAt: IsoDateTimeSchema.nullable(),
}).strict();

export const LearnerEvidenceSchema = z.object({
  id: IdSchema, enrollmentId: IdSchema, outcomeId: IdSchema,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("attempt"), attemptId: IdSchema }).strict(),
    z.object({ kind: z.literal("self_report"), messageId: IdSchema }).strict(),
  ]),
  observation: z.enum(["independent_success", "assisted_success", "incorrect", "partial", "uncertain", "self_reported"]),
  dimensionIds: z.array(z.string().min(1)), recordedAt: IsoDateTimeSchema,
}).strict();

export const RouteReasonSchema = z.enum([
  "course_sequence", "explanation", "diagnostic_clarification", "additional_practice",
  "prerequisite_support", "challenge", "scheduled_review",
]);
export const PersonalRouteSchema = z.object({
  enrollmentId: IdSchema, revision: RevisionSchema, policyVersion: z.string().min(1),
  targetOutcomeIds: z.array(IdSchema),
  next: z.array(z.object({
    lessonId: IdSchema, taskId: IdSchema.nullable(), reasonCode: RouteReasonSchema,
    basisEvidenceIds: z.array(IdSchema),
  }).strict()),
  coveredOutcomeIds: z.array(IdSchema), pendingOutcomeIds: z.array(IdSchema),
}).strict();

export const ProgressSummarySchema = z.object({
  xpTotal: z.number().int().nonnegative(), level: z.number().int().positive(),
  xpToNextLevel: z.number().int().nonnegative(),
  completedRequiredOutcomes: z.number().int().nonnegative(),
  totalRequiredOutcomes: z.number().int().nonnegative(),
  publication: z.object({
    eligible: z.boolean(), requiredLevel: z.number().int().positive(), reasons: z.array(z.string()),
  }).strict(),
}).strict();

export type LessonBlock = z.infer<typeof LessonBlockSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
export type AttemptPayload = z.infer<typeof AttemptPayloadSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type SampleAttempt = z.infer<typeof SampleAttemptSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type Enrollment = z.infer<typeof EnrollmentSchema>;
export type LearnerEvidence = z.infer<typeof LearnerEvidenceSchema>;
export type RouteReason = z.infer<typeof RouteReasonSchema>;
export type PersonalRoute = z.infer<typeof PersonalRouteSchema>;
export type ProgressSummary = z.infer<typeof ProgressSummarySchema>;
