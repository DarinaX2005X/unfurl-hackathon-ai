import { z } from "zod";
import { ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";
import { CourseArtifactRefSchema } from "./chat";
import { CurriculumApprovalSchema, CurriculumDraftSchema, ModuleOutlineSchema, OutcomeSchema } from "./course";
import { AgentTurnRunSchema, GenerationRunSchema } from "./generation";

const nonemptyPatch = (value: object) => Object.values(value).some((field) => field !== undefined);
const OutcomeChangesSchema = OutcomeSchema.omit({ id: true }).partial().strict().refine(nonemptyPatch, "Provide at least one change");
const ModuleChangesSchema = ModuleOutlineSchema.omit({ id: true }).partial().strict().refine(nonemptyPatch, "Provide at least one change");

/** This is the entire authoring command surface. IDs, sources and approvals are not arbitrary patches. */
export const CurriculumChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_details"), ...CurriculumDraftSchema.pick({
    title: true, goal: true, audience: true, assumedKnowledge: true,
  }).partial().shape }).strict().refine((value) => Object.entries(value).some(([key, field]) => key !== "op" && field !== undefined), "Provide at least one change"),
  z.object({ op: z.literal("add_outcome"), outcome: OutcomeSchema }).strict(),
  z.object({ op: z.literal("update_outcome"), id: IdSchema, changes: OutcomeChangesSchema }).strict(),
  z.object({ op: z.literal("remove_outcome"), id: IdSchema }).strict(),
  z.object({ op: z.literal("add_module"), module: ModuleOutlineSchema, afterModuleId: IdSchema.nullable() }).strict(),
  z.object({ op: z.literal("update_module"), id: IdSchema, changes: ModuleChangesSchema }).strict(),
  z.object({ op: z.literal("remove_module"), id: IdSchema }).strict(),
  z.object({ op: z.literal("reorder_modules"), moduleIds: z.array(IdSchema).min(1) }).strict(),
  z.object({ op: z.literal("answer_question"), id: IdSchema, answer: z.string().trim().min(1).max(4000) }).strict(),
]);
export type CurriculumChange = z.infer<typeof CurriculumChangeSchema>;

export const PatchCurriculumInputSchema = z.object({
  expectedRevision: RevisionSchema,
  // A request bound, not a limit on curriculum depth; further changes use another revision.
  changes: z.array(CurriculumChangeSchema).min(1).max(256),
}).strict();
export type PatchCurriculumInput = z.infer<typeof PatchCurriculumInputSchema>;
export const ApproveCurriculumInputSchema = z.object({ expectedRevision: RevisionSchema, contentDigest: DigestSchema }).strict();
export type ApproveCurriculumInput = z.infer<typeof ApproveCurriculumInputSchema>;

export const EditCourseMetadataInputSchema = z.object({
  expectedRevision: RevisionSchema,
  title: CurriculumDraftSchema.shape.title,
  summary: z.string().trim().min(1).max(4000),
}).strict();
export type CourseMetadataInput = z.infer<typeof EditCourseMetadataInputSchema>;
export const RequestCourseLanguageInputSchema = z.object({
  expectedRevision: RevisionSchema, expectedDraftRevision: RevisionSchema, contentLanguage: ContentLanguageSchema,
}).strict();
export type RequestCourseLanguageInput = z.infer<typeof RequestCourseLanguageInputSchema>;

const citationUrl = z.string().max(4096).refine((value) => {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, "Use a source URL");
export const CurriculumCitationSchema = z.object({
  sourceId: IdSchema, title: z.string().min(1).max(1000), url: citationUrl,
  retrievedAt: IsoDateTimeSchema, publishedAt: IsoDateTimeSchema.nullable(), extractionState: z.enum(["complete", "truncated"]),
}).strict();
export const ModuleEstimateSchema = z.object({
  moduleId: IdSchema, minMinutes: z.number().finite().positive(), maxMinutes: z.number().finite().positive(),
  assumptions: z.array(z.string().trim().min(1).max(1000)).min(1),
}).strict().refine((value) => value.minMinutes <= value.maxMinutes, "The estimated range is reversed");
export type ModuleEstimate = z.infer<typeof ModuleEstimateSchema>;

/** A bounded public projection, separate from raw documents, private prompts and future lessons. */
export const CurriculumEvidencePublicSchema = z.object({
  status: z.enum(["verified", "needs_research", "blocked"]),
  rationale: z.string().trim().min(1).max(12000),
  sources: z.array(CurriculumCitationSchema),
  outcomes: z.array(z.object({
    outcomeId: IdSchema, rationale: z.string().trim().min(1).max(4000),
    sourceIds: z.array(IdSchema), support: z.enum(["direct", "inferred", "unverified"]),
  }).strict()),
  estimates: z.array(ModuleEstimateSchema),
  limitations: z.array(z.string().trim().min(1).max(2000)),
  answers: z.array(z.object({ questionId: IdSchema, question: z.string().min(1).max(4000),
    answer: z.string().min(1).max(4000), resolved: z.boolean() }).strict()),
}).strict();
export type CurriculumEvidencePublic = z.infer<typeof CurriculumEvidencePublicSchema>;

export const CurriculumMutationResultSchema = z.object({
  draft: CurriculumDraftSchema, contentDigest: DigestSchema, artifact: CourseArtifactRefSchema,
}).strict().superRefine((value, ctx) => {
  if (value.artifact.courseId !== value.draft.courseId || value.artifact.curriculum?.id !== value.draft.id
    || JSON.stringify(value.artifact.curriculum) !== JSON.stringify(value.draft)) {
    ctx.addIssue({ code: "custom", path: ["artifact"], message: "The acknowledgement must contain this curriculum revision" });
  }
});
export type CurriculumMutationResult = z.infer<typeof CurriculumMutationResultSchema>;
export const CurriculumAuthoringSnapshotSchema = CurriculumMutationResultSchema.safeExtend({
  evidence: CurriculumEvidencePublicSchema,
  generationRun: GenerationRunSchema.nullable(),
  languageRun: AgentTurnRunSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.generationRun && (value.generationRun.courseId !== value.artifact.courseId
    || value.generationRun.approvalId !== value.artifact.approval?.id
    || value.generationRun.sourceDraftRevision !== value.draft.revision
    || value.generationRun.ownerId !== value.artifact.approval?.approvedBy)) {
    ctx.addIssue({ code: "custom", path: ["generationRun"], message: "The build must belong to this exact approval" });
  }
  if (value.languageRun && value.languageRun.conversationId !== value.draft.conversationId) {
    ctx.addIssue({ code: "custom", path: ["languageRun"], message: "The language request must belong to this curriculum's conversation" });
  }
});
export type CurriculumAuthoringSnapshot = z.infer<typeof CurriculumAuthoringSnapshotSchema>;

export const CurriculumApprovalResultSchema = z.object({
  approval: CurriculumApprovalSchema, run: GenerationRunSchema, artifact: CourseArtifactRefSchema,
}).strict().superRefine((value, ctx) => {
  const draft = value.artifact.curriculum;
  if (!draft || value.approval.draftId !== draft.id || value.approval.draftRevision !== draft.revision
    || value.run.approvalId !== value.approval.id || value.run.courseId !== value.artifact.courseId
    || value.run.sourceDraftRevision !== draft.revision || JSON.stringify(value.artifact.approval) !== JSON.stringify(value.approval)) {
    ctx.addIssue({ code: "custom", message: "Approval must identify this course, curriculum revision and build" });
  }
});
export type CurriculumApprovalResult = z.infer<typeof CurriculumApprovalResultSchema>;
export const CourseLanguageRequestResultSchema = z.object({ run: AgentTurnRunSchema, artifact: CourseArtifactRefSchema }).strict().refine(
  (value) => value.artifact.curriculum?.conversationId === value.run.conversationId,
  "The language request must belong to this course's conversation",
);
export type CourseLanguageRequestResult = z.infer<typeof CourseLanguageRequestResultSchema>;
