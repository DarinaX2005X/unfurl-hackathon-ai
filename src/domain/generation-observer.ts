import { z } from "zod";
import { DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";
import { ApiErrorDetailSchema } from "./errors";
import { GenerationRunSchema, RunPhaseSchema } from "./generation";

const generationIdentity = {
  id: IdSchema, runId: IdSchema, courseId: IdSchema, branchId: IdSchema,
  seq: z.number().int().positive(), at: IsoDateTimeSchema,
};
export const SafeValidationSummarySchema = z.object({
  checked: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  categories: z.array(z.enum(["structure", "sources", "coverage", "answer_separation", "assessment", "content_review", "execution"])).max(7),
}).strict().superRefine((summary, ctx) => {
  if (summary.passed + summary.failed !== summary.checked || new Set(summary.categories).size !== summary.categories.length) {
    ctx.addIssue({ code: "custom", message: "Validation counters and categories must be consistent" });
  }
});
export const GenerationEventSchema = z.discriminatedUnion("type", [
  z.object({ ...generationIdentity, type: z.literal("generation.accepted"), status: z.literal("queued") }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.phase.changed"), phase: RunPhaseSchema }).strict(),
  z.object({ ...generationIdentity, type: z.literal("generation.module.completed"), moduleId: IdSchema, completedTasks: z.number().int().positive() }).strict(),
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
export const GenerationSnapshotSchema = z.object({
  run: GenerationRunSchema,
  approvedDraftRevision: RevisionSchema, approvalDigest: DigestSchema,
  modules: z.array(GenerationModuleStateSchema),
  work: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive().nullable() }).strict(),
  validation: SafeValidationSummarySchema.nullable(),
  readyVersionId: IdSchema.nullable(), lastSeq: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.run.courseId === null || snapshot.run.approvalId === null || snapshot.lastSeq !== snapshot.run.lastSeq ||
    snapshot.readyVersionId !== snapshot.run.outputVersionId || snapshot.approvedDraftRevision !== snapshot.run.sourceDraftRevision ||
    (snapshot.work.total !== null && snapshot.work.completed > snapshot.work.total) ||
    new Set(snapshot.modules.map((module) => module.moduleId)).size !== snapshot.modules.length) {
    ctx.addIssue({ code: "custom", message: "A generation snapshot must describe one saved approved build" });
  }
});
export type GenerationEvent = z.infer<typeof GenerationEventSchema>;
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
export type SafeValidationSummary = z.infer<typeof SafeValidationSummarySchema>;
