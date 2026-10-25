import "server-only";
import { z } from "zod";
import { ContentLanguageSchema, IdSchema, JsonValueSchema, RevisionSchema } from "../../domain/common";
import { CurriculumChangeSchema } from "../../domain/curriculum-authoring";
import { CurriculumDraftSchema } from "../../domain/course";
import { SearchInputSchema, SourceUrlSchema } from "../research/ports";

export const SourceSelectionSchema = z.object({ sourceId: IdSchema, blockIds: z.array(z.string().min(1).max(80)).min(1).max(64) }).strict();
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;
const selections = z.array(SourceSelectionSchema).min(1);

/** No owner, approval, publish, enrollment, delete, code execution or tool-extension operation exists. */
export const LegacyAgentDecisionSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search"), input: SearchInputSchema }).strict(),
  z.object({ tool: z.literal("read_source"), input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: SourceUrlSchema }).strict(),
    z.object({ kind: z.literal("blocks"), sourceId: IdSchema, blockIds: z.array(z.string().min(1).max(80)).max(64) }).strict(),
  ]) }).strict(),
  z.object({ tool: z.literal("read_artifact"), input: z.object({ courseId: IdSchema,
    page: z.object({ kind: z.enum(["outcomes", "modules", "questions", "sources"]), offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(12) }).strict().optional(),
  }).strict() }).strict(),
  z.object({ tool: z.literal("create_course"), input: z.object({
    goal: z.string().trim().min(1).max(4000), audience: z.string().trim().min(1).max(4000),
    assumedKnowledge: z.array(z.string().trim().min(1).max(500)), contentLanguage: ContentLanguageSchema,
    requiredCapabilities: z.array(z.string().trim().min(1).max(1000)).min(1), sources: selections,
  }).strict() }).strict(),
  z.object({ tool: z.literal("revise_curriculum"), input: z.object({
    draftId: IdSchema, expectedRevision: RevisionSchema,
    // Empty means research the existing revision; this is not an arbitrary document replacement.
    changes: z.array(CurriculumChangeSchema).max(256), sources: selections,
  }).strict() }).strict(),
  z.object({ tool: z.literal("update_metadata"), input: z.object({
    courseId: IdSchema, expectedRevision: RevisionSchema, title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(4000),
  }).strict() }).strict(),
  z.object({ tool: z.literal("revise_language"), input: z.object({
    courseId: IdSchema, expectedRevision: RevisionSchema, expectedDraftRevision: RevisionSchema,
    contentLanguage: ContentLanguageSchema, sources: selections,
  }).strict() }).strict(),
  z.object({ tool: z.literal("respond"), input: z.object({
    text: z.string().trim().min(1).max(20000), awaitingUser: z.boolean(),
  }).strict() }).strict(),
]);
/** Old saved captures retain their exact paid request schema; only new captures expose this retrieval variant. */
export const AgentDecisionSchema = z.discriminatedUnion("tool", [
  LegacyAgentDecisionSchema.options[0],
  z.object({ tool: z.literal("read_source"), input: z.discriminatedUnion("kind", [
    ...LegacyAgentDecisionSchema.options[1].shape.input.options,
    z.object({ kind: z.literal("search_result"), searchId: IdSchema, offset: z.number().int().min(0).max(5),
      limit: z.number().int().min(1).max(5) }).strict(),
  ]) }).strict(),
  ...LegacyAgentDecisionSchema.options.slice(2),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const ToolObservationSchema = z.object({
  tool: z.string().min(1).max(80), ok: z.boolean(), summary: z.string().min(1).max(4000),
  data: JsonValueSchema, sourceIds: z.array(IdSchema), artifactIds: z.array(IdSchema),
}).strict();
export type ToolObservation = z.infer<typeof ToolObservationSchema>;
export const AgentDecisionReceiptSchema = z.object({
  kind: z.literal("decision"), index: z.number().int().nonnegative(), invocationId: IdSchema, decision: AgentDecisionSchema,
  capturedDraft: CurriculumDraftSchema.nullable(), capturedCourseRevision: RevisionSchema.nullable(),
  preparationError: z.string().min(1).max(200).nullable(),
}).strict();
export type AgentDecisionReceipt = z.infer<typeof AgentDecisionReceiptSchema>;

export interface AgentToolAuthority {
  ownerId: string; runId: string; conversationId: string; branchId: string; inputMessageId: string;
  /** Always loaded from conversation_artifacts, never accepted from a tool's argument object. */
  artifactIds: ReadonlySet<string>;
  /** Read receipts and owned immutable revision evidence are the only source grants. */
  sourceIds: ReadonlySet<string>;
}
