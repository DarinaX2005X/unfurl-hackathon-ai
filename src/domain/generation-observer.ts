import { z } from "zod";
import { ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";
import { ApiErrorDetailSchema } from "./errors";
import { ActionDetailsSchema, GenerationRunSchema, RunPhaseSchema } from "./generation";

const generationIdentity = {
  id: IdSchema, runId: IdSchema, courseId: IdSchema, branchId: IdSchema,
  seq: z.number().int().positive(), at: IsoDateTimeSchema,
};
export const GenerationStageSchema = z.enum(["preparing", "researching", "reading_sources", "planning_lessons", "writing_lessons", "creating_practice",
  "validating_practice", "reviewing_section", "saving_section", "finalizing_course"]);
export const GenerationActionSchema = z.enum(["research_plan", "search", "select_sources", "read_source", "extract_claims", "review_knowledge", "synthesize_knowledge",
  "plan_lessons", "write_lessons", "create_practice", "test_practice", "review_section", "save_section"]);
const timelineVariants = [
  z.object({ ...generationIdentity, type: z.literal("generation.commentary"), stepId: IdSchema,
    text: z.string().trim().min(1).max(1600) }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.action.started"), invocationId: IdSchema,
    stage: GenerationStageSchema, moduleId: IdSchema.optional(), action: GenerationActionSchema.optional(), details: ActionDetailsSchema.optional() }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.action.completed"), invocationId: IdSchema,
    stage: GenerationStageSchema, moduleId: IdSchema.optional(), action: GenerationActionSchema.optional(), details: ActionDetailsSchema.optional(), result: z.object({
      sourceCount: z.number().int().nonnegative().optional(), lessonCount: z.number().int().nonnegative().optional(),
      taskCount: z.number().int().nonnegative().optional(),
      outcome: z.enum(["unavailable", "needs_revision"]).optional(),
    }).strict() }).strict(),
] as const;
export const GenerationTimelineEventSchema = z.discriminatedUnion("type", timelineVariants);
export const GenerationHistoryPageSchema = z.object({ runId: IdSchema, courseId: IdSchema, branchId: IdSchema,
  items: z.array(GenerationTimelineEventSchema).max(100), beforeSeq: z.number().int().positive().nullable(),
}).strict().superRefine((page, ctx) => {
  if (page.items.some((event, index) => event.runId !== page.runId || event.courseId !== page.courseId || event.branchId !== page.branchId
    || (index > 0 && event.seq <= page.items[index - 1]!.seq)) || new Set(page.items.map(event => event.id)).size !== page.items.length
    || (page.beforeSeq !== null && page.beforeSeq !== page.items[0]?.seq))
    ctx.addIssue({ code: "custom", message: "Build history must retain one run's ordered immutable events" });
});
export const GenerationReadyCourseSchema = z.object({ courseId: IdSchema, courseVersionId: IdSchema,
  title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(4000), contentLanguage: ContentLanguageSchema,
  moduleCount: z.number().int().positive(), lessonCount: z.number().int().positive(),
}).strict();
export const SafeValidationSummarySchema = z.object({
  checked: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  categories: z.array(z.enum(["structure", "sources", "coverage", "answer_separation", "assessment", "content_review", "execution"])).max(7),
}).strict().superRefine((summary, ctx) => {
  if (summary.passed + summary.failed !== summary.checked || new Set(summary.categories).size !== summary.categories.length) {
    ctx.addIssue({ code: "custom", message: "Validation counters and categories must be consistent" });
  }
});
export const GenerationEventSchema = z.discriminatedUnion("type", [
  ...timelineVariants,
  z.object({ ...generationIdentity, type: z.literal("generation.accepted"), status: z.literal("queued") }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.phase.changed"), phase: RunPhaseSchema }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.module.completed"), moduleId: IdSchema, completedTasks: z.number().int().nonnegative() }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.validation.summary"), summary: SafeValidationSummarySchema }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.succeeded"), courseVersionId: IdSchema }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.failed"), error: ApiErrorDetailSchema }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.cancelled"), reason: z.enum(["user", "superseded"]) }).strict(),
]);
export const GenerationModuleStateSchema = z.object({
  moduleId: IdSchema, title: z.string().trim().min(1).max(240),
  status: z.enum(["pending", "researching", "building", "validating", "complete", "failed"]),
  completedTasks: z.number().int().nonnegative(),
}).strict();
export const GenerationProgressSchema = z.object({
  stage: GenerationStageSchema,
  activity: z.enum(["running", "waiting"]),
  moduleId: IdSchema.optional(), completedSources: z.number().int().nonnegative().optional(), updatedAt: IsoDateTimeSchema,
}).strict();
export const GenerationSnapshotSchema = z.object({
  run: GenerationRunSchema,
  approvedDraftRevision: RevisionSchema, approvalDigest: DigestSchema,
  modules: z.array(GenerationModuleStateSchema),
  work: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive().nullable() }).strict(),
  validation: SafeValidationSummarySchema.nullable(),
  readyVersionId: IdSchema.nullable(), lastSeq: z.number().int().nonnegative(),
  progress: GenerationProgressSchema.optional(),
  retainedTimelineEvents: z.array(GenerationTimelineEventSchema).max(100).optional(),
  timelineBeforeSeq: z.number().int().positive().nullable().optional(),
  readyCourse: GenerationReadyCourseSchema.nullable().optional(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.run.courseId === null || snapshot.run.approvalId === null || snapshot.lastSeq !== snapshot.run.lastSeq ||
    snapshot.readyVersionId !== snapshot.run.outputVersionId || snapshot.approvedDraftRevision !== snapshot.run.sourceDraftRevision ||
    (snapshot.work.total !== null && snapshot.work.completed > snapshot.work.total) ||
    new Set(snapshot.modules.map((module) => module.moduleId)).size !== snapshot.modules.length) {
    ctx.addIssue({ code: "custom", message: "A generation snapshot must describe one saved approved build" });
  }
  if (snapshot.progress && (!["queued", "running"].includes(snapshot.run.status)
    || (snapshot.progress.moduleId !== undefined && !snapshot.modules.some(module => module.moduleId === snapshot.progress!.moduleId))
    || (snapshot.progress.completedSources !== undefined && snapshot.progress.moduleId === undefined))) {
    ctx.addIssue({ code: "custom", path: ["progress"], message: "Progress must describe an active build and its approved modules" });
  }
  const events = snapshot.retainedTimelineEvents ?? [];
  if (events.some((event, index) => event.runId !== snapshot.run.id || event.courseId !== snapshot.run.courseId
    || event.branchId !== snapshot.run.branchId || event.seq > snapshot.lastSeq
    || (index > 0 && event.seq <= events[index - 1]!.seq)) || new Set(events.map(event => event.id)).size !== events.length
    || (snapshot.timelineBeforeSeq != null && snapshot.timelineBeforeSeq !== events[0]?.seq))
    ctx.addIssue({ code: "custom", path: ["retainedTimelineEvents"], message: "Timeline events must belong to this saved build" });
  if (snapshot.readyCourse && (snapshot.run.status !== "succeeded" || snapshot.readyCourse.courseId !== snapshot.run.courseId
    || snapshot.readyCourse.courseVersionId !== snapshot.readyVersionId))
    ctx.addIssue({ code: "custom", path: ["readyCourse"], message: "A ready card must describe this build's saved output version" });
});
export type GenerationEvent = z.infer<typeof GenerationEventSchema>;
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
export type SafeValidationSummary = z.infer<typeof SafeValidationSummarySchema>;
export type GenerationProgress = z.infer<typeof GenerationProgressSchema>;
export type GenerationTimelineEvent = z.infer<typeof GenerationTimelineEventSchema>;
export type GenerationHistoryPage = z.infer<typeof GenerationHistoryPageSchema>;
export type GenerationAction = z.infer<typeof GenerationActionSchema>;
