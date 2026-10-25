import { z } from "zod";
import { ContentLanguageSchema, IdSchema, IsoDateTimeSchema, RevisionSchema, type Id, type Revision } from "@/domain/common";
import {
  ActionReceiptSchema, ActivitySessionPublicSchema, InputSnapshotSchema,
  canonicalResponseJson,
  type ActivityActionRequest, type SaveActivityInput, type SubmitActivityAttempt,
} from "@/domain/activity";
import {
  AssessmentReviewRequestSchema, EnrollmentSchema, EvaluationReceiptSchema, FeedbackAcknowledgementSchema,
  LearningSessionSchema, PersonalRouteSchema, ProgressSummarySchema, SupportOfferSchema,
  type EvaluationReceipt, type FeedbackAcknowledgement, type LearningSession,
} from "@/domain/learning";
import type { ServiceResult } from "./ports";

export const StartActivityInputSchema = z.object({ taskId: IdSchema, taskVersion: RevisionSchema }).strict();
export const ActionRetryInputSchema = z.object({ expectedRevision: RevisionSchema }).strict();
export const EvaluationRevisionInputSchema = z.object({ expectedEvaluationRevision: RevisionSchema }).strict();
export const RouteRevisionInputSchema = z.object({ expectedRouteRevision: RevisionSchema }).strict();
export const RevisitInputSchema = RouteRevisionInputSchema.extend({ lessonId: IdSchema, taskId: IdSchema.nullable() }).strict();
export const HintInputSchema = StartActivityInputSchema.extend({ hintIndex: z.number().int().min(0).max(5) }).strict();
export const SupportRequestSchema = RouteRevisionInputSchema.extend({ targetOutcomeId: IdSchema,
  kind: z.enum(["explanation", "diagnostic_clarification", "additional_practice", "prerequisite_support", "challenge"]),
  message: z.string().trim().max(500).optional(),
}).strict();
export const SupportResponseInputSchema = RouteRevisionInputSchema.extend({ response: z.enum(["accept", "decline"]) }).strict();
export const AssessmentReviewInputSchema = EvaluationRevisionInputSchema.extend({
  reason: z.enum(["valid_alternative", "unclear_prompt", "other"]), comment: z.string().trim().min(1).max(2_000),
}).strict();
export const LearningContextQuerySchema = z.object({ cursor: z.string().min(1).max(512).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const FreshAssessmentAvailabilitySchema = z.object({
  availability: z.enum(["available", "not_needed", "no_unseen_assessment", "blocked"]),
  blockedReason: z.enum(["support_active", "review_active", "archived"]).nullable(),
  outcomeIds: z.array(IdSchema),
}).strict();
export const LearningContextSchema = z.object({
  enrollmentId: IdSchema, routeRevision: RevisionSchema,
  course: z.object({ id: IdSchema, versionId: IdSchema, versionNumber: RevisionSchema, title: z.string().trim().min(1).max(120), contentLanguage: ContentLanguageSchema }).strict(),
  outcomes: z.array(z.object({ id: IdSchema, title: z.string().trim().min(1).max(120) }).strict()).max(10_000),
  outline: z.array(z.object({ lessonId: IdSchema, title: z.string().min(1), outcomeIds: z.array(IdSchema),
    availability: z.enum(["current", "completed", "upcoming"]),
    positions: z.array(z.object({ taskId: IdSchema.nullable(), taskVersion: RevisionSchema.nullable(), instruction: z.string().min(1).max(20_000).nullable(), revisitable: z.boolean() }).strict())
      .superRefine((positions, context) => { positions.forEach((position, index) => { if ((position.taskId === null) !== (position.taskVersion === null) || (position.taskId === null) !== (position.instruction === null)) context.addIssue({ code: "custom", path: [index], message: "Task navigation identity must be complete" }); }); }),
  }).strict()).max(100),
  outlineNextCursor: z.string().min(1).max(512).nullable(),
  citations: z.array(z.object({ id: IdSchema, title: z.string().min(1), url: z.url().refine((value) => { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }), retrievedAt: IsoDateTimeSchema }).strict()),
  assistance: z.object({ taskId: IdSchema, taskVersion: RevisionSchema, level: z.enum(["independent", "hinted", "worked_example"]),
    hints: z.array(z.object({ hintId: IdSchema, index: z.number().int().min(0).max(5), content: z.string().min(1).max(4_000), usedAt: IsoDateTimeSchema }).strict()).max(6),
    workedExample: z.object({ content: z.string().min(1).max(12_000), usedAt: IsoDateTimeSchema }).strict().nullable(),
  }).strict().nullable(),
  revisitBlockedReason: z.enum(["support_active", "review_active", "archived"]).nullable(),
  freshAssessment: FreshAssessmentAvailabilitySchema,
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2 * 1024 * 1024) context.addIssue({ code: "custom", message: "Learning context exceeds 2 MiB" });
  if (new Set(value.outline.map(({ lessonId }) => lessonId)).size !== value.outline.length || new Set(value.outcomes.map(({ id }) => id)).size !== value.outcomes.length ||
    new Set(value.citations.map(({ id }) => id)).size !== value.citations.length) context.addIssue({ code: "custom", message: "Context identifiers must be unique" });
});
export type LearningContext = z.infer<typeof LearningContextSchema>;
export type LearningContextQuery = z.infer<typeof LearningContextQuerySchema>;

const activityFields = { activity: ActivitySessionPublicSchema, savedInput: InputSnapshotSchema.nullable() };
function validateActivityState(value: { activity: z.infer<typeof ActivitySessionPublicSchema>; savedInput: z.infer<typeof InputSnapshotSchema> | null }, context: z.RefinementCtx) {
  if (value.savedInput === null ? value.activity.inputRevision !== 0 :
    value.savedInput.activitySessionId !== value.activity.id || value.savedInput.inputRevision !== value.activity.inputRevision) {
    context.addIssue({ code: "custom", path: ["savedInput"], message: "The saved input must match the current activity revision" });
  }
}
export const ActivityStateSchema = z.object(activityFields).strict().superRefine(validateActivityState);
export const ActivityActionResultSchema = z.object({ ...activityFields, receipt: ActionReceiptSchema }).strict().superRefine((value, context) => {
  validateActivityState(value, context);
  if (!value.activity.events.some((event) => event.receipt.input.activitySessionId === value.activity.id &&
    canonicalResponseJson(event.receipt) === canonicalResponseJson(value.receipt))) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "Action receipt must be present in its activity" });
  }
});
export const AttemptReceiptSchema = z.object({ attemptId: IdSchema, evaluation: EvaluationReceiptSchema,
  route: PersonalRouteSchema, progress: ProgressSummarySchema, support: SupportOfferSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.evaluation.evaluation.attemptId !== value.attemptId ||
    (value.support !== null && value.support.enrollmentId !== value.route.enrollmentId)) {
    context.addIssue({ code: "custom", message: "Attempt receipt identities must agree" });
  }
});
export const AssistanceReceiptSchema = z.object({ hintId: IdSchema, content: z.string().trim().min(1).max(4_000),
  assistance: z.enum(["hinted", "worked_example"]),
}).strict();
export const RevealReceiptSchema = z.object({ content: z.string().trim().min(1).max(12_000), assistance: z.literal("worked_example") }).strict();
export const SupportProposalSchema = z.object({ offer: SupportOfferSchema, route: PersonalRouteSchema }).strict().superRefine((value, context) => {
  if (value.offer.enrollmentId !== value.route.enrollmentId) context.addIssue({ code: "custom", message: "Support belongs to another route" });
});
export const SupportResultSchema = z.object({ offer: SupportOfferSchema, route: PersonalRouteSchema, enrollment: EnrollmentSchema }).strict().superRefine((value, context) => {
  if (value.offer.enrollmentId !== value.enrollment.id || value.route.enrollmentId !== value.enrollment.id ||
    value.route.revision !== value.enrollment.routeRevision || value.offer.courseVersionId !== value.enrollment.courseVersionId) {
    context.addIssue({ code: "custom", message: "Support and route must belong to the current enrollment" });
  }
});
export const ReviewReceiptSchema = z.object({ review: AssessmentReviewRequestSchema, evaluation: EvaluationReceiptSchema }).strict().superRefine((value, context) => {
  if (value.review.id !== value.evaluation.review?.id || value.review.evaluationId !== value.evaluation.evaluation.id ||
    value.review.attemptId !== value.evaluation.evaluation.attemptId) context.addIssue({ code: "custom", message: "Review identities must agree" });
});

export type ActivityState = z.infer<typeof ActivityStateSchema>;
export type ActivityActionResult = z.infer<typeof ActivityActionResultSchema>;
export type AttemptReceipt = z.infer<typeof AttemptReceiptSchema>;
export type AssistanceReceipt = z.infer<typeof AssistanceReceiptSchema>;
export type RevealReceipt = z.infer<typeof RevealReceiptSchema>;
export type SupportResult = z.infer<typeof SupportResultSchema>;
export type SupportRequest = z.infer<typeof SupportRequestSchema>;
export type AssessmentReviewInput = z.infer<typeof AssessmentReviewInputSchema>;
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export type MutationOptions = { idempotencyKey: Id; signal?: AbortSignal };
export interface LearningPort {
  loadSession(enrollmentId: Id, signal?: AbortSignal): Promise<ServiceResult<LearningSession>>;
  loadContext(enrollmentId: Id, query?: LearningContextQuery, signal?: AbortSignal): Promise<ServiceResult<LearningContext>>;
  startActivity(enrollmentId: Id, input: z.infer<typeof StartActivityInputSchema>, options: MutationOptions): Promise<ServiceResult<ActivityState>>;
  getActivity(activitySessionId: Id, signal?: AbortSignal): Promise<ServiceResult<ActivityState>>;
  saveInput(activitySessionId: Id, input: SaveActivityInput, options: MutationOptions): Promise<ServiceResult<ActivityState>>;
  dispatchAction(activitySessionId: Id, input: ActivityActionRequest, options: MutationOptions): Promise<ServiceResult<ActivityActionResult>>;
  retryAction(activitySessionId: Id, receiptId: Id, input: { expectedRevision: Revision }, options: MutationOptions): Promise<ServiceResult<ActivityActionResult>>;
  submitAttempt(enrollmentId: Id, input: SubmitActivityAttempt, options: MutationOptions): Promise<ServiceResult<AttemptReceipt>>;
  getEvaluation(attemptId: Id, signal?: AbortSignal): Promise<ServiceResult<EvaluationReceipt>>;
  retryEvaluation(attemptId: Id, input: { expectedEvaluationRevision: Revision }, options: MutationOptions): Promise<ServiceResult<EvaluationReceipt>>;
  requestHint(enrollmentId: Id, input: z.infer<typeof HintInputSchema>, options: MutationOptions): Promise<ServiceResult<AssistanceReceipt>>;
  revealAnswer(enrollmentId: Id, input: z.infer<typeof StartActivityInputSchema>, options: MutationOptions): Promise<ServiceResult<RevealReceipt>>;
  acknowledgeFeedback(attemptId: Id, input: { expectedEvaluationRevision: Revision }, options: MutationOptions): Promise<ServiceResult<FeedbackAcknowledgement>>;
  advance(enrollmentId: Id, input: { expectedRouteRevision: Revision }, options: MutationOptions): Promise<ServiceResult<LearningSession>>;
  revisit(enrollmentId: Id, input: z.infer<typeof RevisitInputSchema>, options: MutationOptions): Promise<ServiceResult<LearningSession>>;
  requestFreshAssessment(enrollmentId: Id, input: z.infer<typeof RouteRevisionInputSchema>, options: MutationOptions): Promise<ServiceResult<LearningSession>>;
  requestSupport(enrollmentId: Id, input: SupportRequest, options: MutationOptions): Promise<ServiceResult<z.infer<typeof SupportProposalSchema>>>;
  respondToSupport(enrollmentId: Id, offerId: Id, input: z.infer<typeof SupportResponseInputSchema>, options: MutationOptions): Promise<ServiceResult<SupportResult>>;
  returnFromSupport(enrollmentId: Id, offerId: Id, input: { expectedRouteRevision: Revision }, options: MutationOptions): Promise<ServiceResult<SupportResult>>;
  requestReview(attemptId: Id, input: AssessmentReviewInput, options: MutationOptions): Promise<ServiceResult<ReviewReceipt>>;
  retryReview(attemptId: Id, reviewId: Id, input: { expectedEvaluationRevision: Revision }, options: MutationOptions): Promise<ServiceResult<ReviewReceipt>>;
}

// Re-export the canonical response schemas used by the transport; no duplicate DTOs.
export { EvaluationReceiptSchema, FeedbackAcknowledgementSchema, LearningSessionSchema };
