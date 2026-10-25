import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, JsonValueSchema, RevisionSchema } from "./common";
import { ActivitySessionPublicSchema, InputIdentitySchema, InputSnapshotSchema } from "./activity";
import { LocalIdSchema } from "./mechanic-families/v2/shared";
import { TaskPublicSchema } from "./mechanics";

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

export const AccountProgressSchema = ProgressSummarySchema.pick({
  xpTotal: true, level: true, xpToNextLevel: true, publication: true,
}).strict();

const UniqueDimensionIdsSchema = z.array(LocalIdSchema).min(1).max(24).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Dimension identifiers must be unique" });
});

export const SupportOfferSchema = z.object({
  id: IdSchema,
  enrollmentId: IdSchema,
  courseVersionId: IdSchema,
  policyVersion: z.literal("adaptation-v1"),
  basedOnRouteRevision: RevisionSchema,
  target: z.object({ outcomeId: IdSchema, dimensionIds: UniqueDimensionIdsSchema }).strict(),
  triggerKind: z.enum(["auto", "user_request"]),
  reasonCode: RouteReasonSchema.exclude(["course_sequence", "scheduled_review"]),
  basisEvidenceIds: z.array(IdSchema).max(6).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Evidence identifiers must be unique" });
  }),
  explanation: z.string().trim().min(1).max(1_000),
  tasks: z.array(z.object({ lessonId: IdSchema, taskId: IdSchema, taskVersion: RevisionSchema }).strict()).max(2),
  explanationBlock: z.object({ lessonId: IdSchema, blockId: IdSchema }).strict().nullable(),
  estimatedStudyMinutes: z.number().int().min(1).max(8),
  returnPoint: z.object({ lessonId: IdSchema, taskId: IdSchema.nullable() }).strict(),
  completionCheck: z.object({ taskId: IdSchema, dimensionIds: UniqueDimensionIdsSchema }).strict().nullable(),
  status: z.enum(["offered", "accepted", "declined", "returned", "completed", "superseded"]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((offer, context) => {
  if (offer.tasks.length === 0 && offer.explanationBlock === null) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Support needs a validated task or explanation block" });
  }
  if (new Set(offer.tasks.map((task) => task.taskId)).size !== offer.tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Support tasks must be unique" });
  }
  const finalTask = offer.tasks.at(-1)?.taskId;
  if ((offer.tasks.length === 0 && offer.completionCheck !== null)
    || (offer.tasks.length > 0 && offer.completionCheck?.taskId !== finalTask)) {
    context.addIssue({ code: "custom", path: ["completionCheck"], message: "The completion check belongs to the final support task" });
  }
});

export const AssessmentReviewRequestSchema = z.object({
  id: IdSchema,
  attemptId: IdSchema,
  evaluationId: IdSchema,
  expectedEvaluationRevision: RevisionSchema,
  reason: z.enum(["valid_alternative", "unclear_prompt", "other"]),
  comment: z.string().trim().min(1).max(2_000),
  status: z.enum(["queued", "running", "resolved", "unavailable", "superseded"]),
  resolution: z.enum(["upheld", "corrected", "uncertain"]).nullable(),
  resolvedEvaluationRevision: RevisionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
}).strict().superRefine((review, context) => {
  const complete = review.resolution !== null && review.resolvedEvaluationRevision !== null && review.resolvedAt !== null;
  const empty = review.resolution === null && review.resolvedEvaluationRevision === null && review.resolvedAt === null;
  if ((review.status === "resolved" && !complete) || (review.status !== "resolved" && !empty)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Only a resolved review has resolution metadata" });
  }
});

export const EvaluationReceiptSchema = z.object({
  evaluation: EvaluationSchema,
  revision: RevisionSchema,
  review: AssessmentReviewRequestSchema.nullable(),
  submittedInput: InputIdentitySchema,
}).strict();

export const LearningSessionSchema = z.object({
  enrollment: EnrollmentSchema,
  route: PersonalRouteSchema,
  lesson: LessonSchema.nullable(),
  task: TaskPublicSchema.nullable(),
  progress: ProgressSummarySchema,
  activity: ActivitySessionPublicSchema.nullable(),
  savedInput: InputSnapshotSchema.nullable(),
  evaluation: EvaluationReceiptSchema.nullable(),
  support: SupportOfferSchema.nullable(),
}).strict().superRefine((session, context) => {
  if (session.route.enrollmentId !== session.enrollment.id) {
    context.addIssue({ code: "custom", path: ["route", "enrollmentId"], message: "The route belongs to another enrollment" });
  }
  if (session.activity && (session.activity.enrollmentId !== session.enrollment.id || session.activity.taskId !== session.task?.id)) {
    context.addIssue({ code: "custom", path: ["activity"], message: "The activity does not match the selected enrollment and task" });
  }
  if (session.savedInput && session.savedInput.activitySessionId !== session.activity?.id) {
    context.addIssue({ code: "custom", path: ["savedInput"], message: "The saved input belongs to another activity" });
  }
  if (session.support && (session.support.enrollmentId !== session.enrollment.id || session.support.courseVersionId !== session.enrollment.courseVersionId)) {
    context.addIssue({ code: "custom", path: ["support"], message: "The support offer belongs to another enrollment" });
  }
});

export const EnrollmentReceiptSchema = z.object({
  enrollment: EnrollmentSchema,
  redirectTo: z.string().regex(/^\/learn\/[0-9a-f-]{36}$/),
}).strict();

export const FeedbackAcknowledgementSchema = z.object({
  attemptId: IdSchema,
  evaluationRevision: RevisionSchema,
  acknowledgedAt: IsoDateTimeSchema,
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
export type AccountProgress = z.infer<typeof AccountProgressSchema>;
export type SupportOffer = z.infer<typeof SupportOfferSchema>;
export type AssessmentReviewRequest = z.infer<typeof AssessmentReviewRequestSchema>;
export type EvaluationReceipt = z.infer<typeof EvaluationReceiptSchema>;
export type LearningSession = z.infer<typeof LearningSessionSchema>;
export type EnrollmentReceipt = z.infer<typeof EnrollmentReceiptSchema>;
export type FeedbackAcknowledgement = z.infer<typeof FeedbackAcknowledgementSchema>;
