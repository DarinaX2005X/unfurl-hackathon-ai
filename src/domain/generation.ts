import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";
import { CourseArtifactRefSchema } from "./chat";
import { ApiErrorDetailSchema } from "./errors";

export const ConversationSchema = z.object({
  id: IdSchema, ownerId: IdSchema, title: z.string().trim().min(1).max(120),
  activeBranchId: IdSchema, revision: RevisionSchema,
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
}).strict();

export const ChatMessageSchema = z.object({
  id: IdSchema, conversationId: IdSchema, branchId: IdSchema,
  parentMessageId: IdSchema.nullable(),
  role: z.enum(["user", "assistant"]),
  status: z.enum(["complete", "streaming", "interrupted", "failed"]),
  parts: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().max(200_000) }).strict(),
    z.object({ type: z.literal("attachment"), attachmentId: IdSchema }).strict(),
  ])),
  clientRequestId: IdSchema.nullable(), createdAt: IsoDateTimeSchema,
}).strict();

export const RunPhaseSchema = z.enum([
  "briefing", "researching", "outlining", "awaiting_approval", "module_research", "building_tasks", "validating",
]);
export const RunStatusSchema = z.enum(["queued", "running", "awaiting_user", "succeeded", "failed", "cancelled"]);
export const AgentTurnRunSchema = z.object({
  id: IdSchema, ownerId: IdSchema, conversationId: IdSchema, branchId: IdSchema, inputMessageId: IdSchema,
  status: RunStatusSchema, lastSeq: z.number().int().nonnegative(), error: ApiErrorDetailSchema.nullable(),
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
}).strict().superRefine((run, context) => {
  if (run.status === "failed" && run.error === null) context.addIssue({ code: "custom", path: ["error"], message: "A failed turn needs an error" });
});
export const GenerationRunSchema = z.object({
  id: IdSchema, ownerId: IdSchema, courseId: IdSchema.nullable(), conversationId: IdSchema,
  branchId: IdSchema, inputMessageId: IdSchema,
  sourceDraftRevision: RevisionSchema.nullable(), approvalId: IdSchema.nullable(),
  phase: RunPhaseSchema, status: RunStatusSchema,
  lastSeq: z.number().int().nonnegative(), outputVersionId: IdSchema.nullable(),
  error: ApiErrorDetailSchema.nullable(),
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
}).strict().superRefine((run, context) => {
  if (run.status === "succeeded" && (run.outputVersionId === null || run.courseId === null)) {
    context.addIssue({ code: "custom", path: ["outputVersionId"], message: "Completion requires an existing course and a saved course version" });
  }
  if (run.status !== "succeeded" && run.outputVersionId !== null) {
    context.addIssue({ code: "custom", path: ["outputVersionId"], message: "An unfinished run cannot claim a completed course" });
  }
  if (run.status === "failed" && run.error === null) {
    context.addIssue({ code: "custom", path: ["error"], message: "A failed run needs an error" });
  }
});

export const ResearchActionSchema = z.enum([
  "search", "read_source", "compare_sources", "build_outline", "research_module", "construct_tasks", "validate_tasks",
]);

const eventBase = {
  id: IdSchema, runId: IdSchema, branchId: IdSchema,
  seq: z.number().int().positive(), at: IsoDateTimeSchema,
};

const ActionStartedEventSchema = z.object({
  ...eventBase, type: z.literal("action.started"), invocationId: IdSchema,
  action: ResearchActionSchema, labelKey: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
}).strict();
const ActionCompletedEventSchema = z.object({
  ...eventBase, type: z.literal("action.completed"), invocationId: IdSchema,
  resultSummary: z.string(), sourceIds: z.array(IdSchema),
}).strict();
const ActionFailedEventSchema = z.object({
  ...eventBase, type: z.literal("action.failed"), invocationId: IdSchema,
  error: ApiErrorDetailSchema,
}).strict();

export const ActionEventSchema = z.discriminatedUnion("type", [
  ActionStartedEventSchema, ActionCompletedEventSchema, ActionFailedEventSchema,
]);
export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("run.accepted"), status: z.literal("queued") }).strict(),
  z.object({ ...eventBase, type: z.literal("message.started"), messageId: IdSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("message.delta"), messageId: IdSchema, text: z.string().min(1).max(20_000) }).strict(),
  z.object({ ...eventBase, type: z.literal("message.completed"), messageId: IdSchema }).strict(),
  ActionStartedEventSchema, ActionCompletedEventSchema, ActionFailedEventSchema,
  z.object({ ...eventBase, type: z.literal("artifact.updated"), courseId: IdSchema, revision: RevisionSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("outline.updated"), courseId: IdSchema, draftId: IdSchema, revision: RevisionSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("approval.required"), courseId: IdSchema, draftId: IdSchema, revision: RevisionSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("run.awaiting_user") }).strict(),
  z.object({ ...eventBase, type: z.literal("run.completed") }).strict(),
  z.object({ ...eventBase, type: z.literal("run.failed"), error: ApiErrorDetailSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("run.cancelled"), reason: z.enum(["user", "superseded"]) }).strict(),
]);

export const RunSnapshotSchema = z.object({
  run: AgentTurnRunSchema,
  messages: z.array(ChatMessageSchema),
  artifacts: z.array(CourseArtifactRefSchema),
  lastSeq: z.number().int().nonnegative(),
  retainedActionEvents: z.array(ChatEventSchema),
}).strict();

export type Conversation = z.infer<typeof ConversationSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type RunPhase = z.infer<typeof RunPhaseSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type GenerationRun = z.infer<typeof GenerationRunSchema>;
export type AgentTurnRun = z.infer<typeof AgentTurnRunSchema>;
export type ResearchAction = z.infer<typeof ResearchActionSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ActionEvent = z.infer<typeof ActionEventSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
