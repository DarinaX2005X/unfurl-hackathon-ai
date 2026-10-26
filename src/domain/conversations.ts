import { z } from "zod";
import { ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema, RevisionSchema, pageSchema } from "./common";
import { CourseArtifactRefSchema } from "./chat";
import { ActionEventSchema, AgentTurnRunSchema, ChatMessageSchema, ConversationSchema } from "./generation";
import { GenerationSnapshotSchema } from "./generation-observer";

export const MESSAGE_TEXT_LIMIT = 20_000;
export const PENDING_MESSAGE_LIMIT = 100;
export const CONVERSATION_BODY_LIMIT = 2_000_000;
export const MESSAGE_BODY_LIMIT = 100_000;

const textSchema = z.string().max(MESSAGE_TEXT_LIMIT);
const nonemptyTextSchema = textSchema.refine((text) => text.trim().length > 0, "Write a message first");
const titleSchema = z.string().trim().min(1).max(120);
const encoder = new TextEncoder();

export const PendingUserMessageSchema = z.object({
  messageId: IdSchema,
  requestId: IdSchema,
  text: nonemptyTextSchema,
  userLocale: ContentLanguageSchema.optional(),
}).strict();
export type PendingUserMessage = z.infer<typeof PendingUserMessageSchema>;

/** A message is sent against the observed server conversation and branch. */
export const CloudSendMessageInputSchema = PendingUserMessageSchema.extend({
  conversationId: IdSchema,
  expectedRevision: RevisionSchema,
  branchId: IdSchema,
  parentMessageId: IdSchema.nullable(),
}).strict();
export type CloudSendMessageInput = z.infer<typeof CloudSendMessageInputSchema>;

export const PendingUserMessagesSchema = z.array(PendingUserMessageSchema).max(PENDING_MESSAGE_LIMIT).superRefine((messages, context) => {
  for (const field of ["messageId", "requestId"] as const) {
    if (new Set(messages.map((message) => message[field])).size !== messages.length) {
      context.addIssue({ code: "custom", message: "Each pending message needs its own identity", path: [field] });
    }
  }
});

function withinBodyLimit(value: unknown): boolean {
  return encoder.encode(JSON.stringify(value)).byteLength <= CONVERSATION_BODY_LIMIT;
}

function withinComposerLimit(value: { text: string; pendingMessages: PendingUserMessage[] }): boolean {
  // Include serialization overhead conservatively before PostgreSQL's JSONB check.
  return encoder.encode(value.text + JSON.stringify(value.pendingMessages, null, 1)).byteLength <= CONVERSATION_BODY_LIMIT
    && withinBodyLimit(value);
}

export const ComposerDraftSchema = z.object({
  conversationId: IdSchema,
  revision: RevisionSchema,
  text: textSchema,
  pendingMessages: PendingUserMessagesSchema,
  updatedAt: IsoDateTimeSchema,
}).strict().refine(withinComposerLimit, "The saved input is larger than 2 MB");
export type ComposerDraft = z.infer<typeof ComposerDraftSchema>;

/** A user approval is an immutable action, separate from the text-message parent chain. */
export const ConversationBuildSchema = z.object({
  approvalId: IdSchema, draftId: IdSchema, draftRevision: RevisionSchema, approvalDigest: DigestSchema,
  approvedAt: IsoDateTimeSchema, courseId: IdSchema, branchId: IdSchema,
  title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(4000), contentLanguage: ContentLanguageSchema,
  initialRunId: IdSchema, runs: z.array(z.object({ retryOfRunId: IdSchema.nullable(), snapshot: GenerationSnapshotSchema }).strict()).min(1),
}).strict().superRefine((build, ctx) => {
  if (build.runs[0]!.snapshot.run.id !== build.initialRunId || build.runs[0]!.retryOfRunId !== null
    || new Set(build.runs.map(entry => entry.snapshot.run.id)).size !== build.runs.length
    || build.runs.some((entry, index) => entry.snapshot.run.approvalId !== build.approvalId
      || entry.snapshot.run.courseId !== build.courseId || entry.snapshot.run.branchId !== build.branchId
      || entry.snapshot.approvalDigest !== build.approvalDigest || entry.snapshot.approvedDraftRevision !== build.draftRevision
      || (index > 0 && entry.retryOfRunId !== build.runs[index - 1]!.snapshot.run.id)))
    ctx.addIssue({ code: "custom", message: "An approval history must contain its exact ordered retry lineage" });
});
export type ConversationBuild = z.infer<typeof ConversationBuildSchema>;

export const ConversationDetailSchema = z.object({
  conversation: ConversationSchema,
  messages: z.array(ChatMessageSchema),
  activeTurn: AgentTurnRunSchema.nullable(),
  artifacts: z.array(CourseArtifactRefSchema),
  composerDraft: ComposerDraftSchema,
  retainedActionEvents: z.array(ActionEventSchema).optional(),
  actionHistoryNextCursor: z.string().min(1).max(2000).nullable().optional(),
  builds: z.array(ConversationBuildSchema).optional(),
}).strict().superRefine((detail, context) => {
  const { conversation, messages, activeTurn, artifacts, composerDraft } = detail;
  if (composerDraft.conversationId !== conversation.id) context.addIssue({ code: "custom", path: ["composerDraft"], message: "The input belongs to another chat" });
  if (messages.some((message) => message.conversationId !== conversation.id || message.branchId !== conversation.activeBranchId)
    || new Set(messages.map((message) => message.id)).size !== messages.length) {
    context.addIssue({ code: "custom", path: ["messages"], message: "Messages must belong to this chat and branch" });
  }
  if (activeTurn && (activeTurn.conversationId !== conversation.id || activeTurn.branchId !== conversation.activeBranchId || activeTurn.ownerId !== conversation.ownerId)) {
    context.addIssue({ code: "custom", path: ["activeTurn"], message: "The turn belongs to another chat" });
  }
  if (detail.retainedActionEvents?.some((event) => event.branchId !== conversation.activeBranchId)
    || new Set(detail.retainedActionEvents?.map((event) => event.id) ?? []).size !== (detail.retainedActionEvents?.length ?? 0)) {
    context.addIssue({ code: "custom", path: ["retainedActionEvents"], message: "Actions must belong to this chat's visible branch" });
  }
  if (new Set(artifacts.map((artifact) => artifact.courseId)).size !== artifacts.length
    || artifacts.some((artifact) => artifact.curriculum && artifact.curriculum.conversationId !== conversation.id)) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Course references must belong to this chat" });
  }
  if (new Set(detail.builds?.map(build => build.approvalId) ?? []).size !== (detail.builds?.length ?? 0)
    || detail.builds?.some(build => build.branchId !== conversation.activeBranchId || !artifacts.some(artifact => artifact.courseId === build.courseId)
      || build.runs.some(({ snapshot }) => snapshot.run.conversationId !== conversation.id || snapshot.run.ownerId !== conversation.ownerId)))
    context.addIssue({ code: "custom", path: ["builds"], message: "Builds must belong to this owner's visible chat and branch" });
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;
export const ConversationPageSchema = pageSchema(ConversationSchema);

export const ConversationActionQuerySchema = z.object({ cursor: z.string().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(50).optional() }).strict();
export type ConversationActionQuery = z.infer<typeof ConversationActionQuerySchema>;
export const ConversationActionPageSchema = z.object({ conversationId: IdSchema, branchId: IdSchema,
  items: z.array(ActionEventSchema), nextCursor: z.string().min(1).max(2000).nullable() }).strict().superRefine((page, context) => {
  if (page.items.some((event) => event.branchId !== page.branchId) || new Set(page.items.map((event) => event.id)).size !== page.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Actions must belong to this page's visible branch" });
  }
});
export type ConversationActionPage = z.infer<typeof ConversationActionPageSchema>;

export const SendMessageResultSchema = z.object({ message: ChatMessageSchema, run: AgentTurnRunSchema }).strict().superRefine((result, context) => {
  if (result.message.role !== "user" || result.message.conversationId !== result.run.conversationId
    || result.message.id !== result.run.inputMessageId || result.message.branchId !== result.run.branchId) {
    context.addIssue({ code: "custom", message: "The accepted turn must match its user message" });
  }
});

export const ConversationQuerySchema = z.object({
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(60).optional(),
}).strict();
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;

export const CreateConversationInputSchema = z.object({
  title: titleSchema.optional(),
  composerText: nonemptyTextSchema,
}).strict();
export type CreateConversationInput = z.infer<typeof CreateConversationInputSchema>;

export const RenameConversationInputSchema = z.object({ expectedRevision: RevisionSchema, title: titleSchema }).strict();
export type RenameConversationInput = z.infer<typeof RenameConversationInputSchema>;
export const DeleteConversationInputSchema = z.object({ expectedRevision: RevisionSchema }).strict();
export type DeleteConversationInput = z.infer<typeof DeleteConversationInputSchema>;

export const SaveComposerInputSchema = z.object({
  expectedRevision: RevisionSchema,
  text: textSchema,
  pendingMessages: PendingUserMessagesSchema,
}).strict().refine(withinComposerLimit, "The saved input is larger than 2 MB");
export type SaveComposerInput = z.infer<typeof SaveComposerInputSchema>;

export const ImportConversationInputSchema = z.object({
  sourceId: IdSchema,
  sourceRevision: RevisionSchema,
  title: titleSchema,
  composerText: textSchema,
  userMessages: z.array(z.object({
    sourceMessageId: IdSchema,
    text: nonemptyTextSchema,
    userLocale: ContentLanguageSchema.optional(),
    sourceCreatedAt: IsoDateTimeSchema,
  }).strict()).max(PENDING_MESSAGE_LIMIT),
  sourceCreatedAt: IsoDateTimeSchema,
  sourceUpdatedAt: IsoDateTimeSchema,
  legacySource: z.object({ draftId: IdSchema, contentLanguage: ContentLanguageSchema }).strict().optional(),
}).strict().refine(withinBodyLimit, "The import is larger than 2 MB").superRefine((input, context) => {
  if (new Set(input.userMessages.map((message) => message.sourceMessageId)).size !== input.userMessages.length) {
    context.addIssue({ code: "custom", path: ["userMessages"], message: "Source message identities must be unique" });
  }
});
export type ImportConversationInput = z.infer<typeof ImportConversationInputSchema>;
export const ImportConversationResultSchema = z.object({
  sourceId: IdSchema,
  conversation: ConversationDetailSchema,
}).strict();
export type ImportConversationResult = z.infer<typeof ImportConversationResultSchema>;

/** Accepted messages always win over a stale, user-authored delivery buffer. */
export function unacceptedIntents(pending: PendingUserMessage[], messages: Array<{ id: string; clientRequestId: string | null }>): PendingUserMessage[] {
  return pending.filter((intent) => !messages.some((message) => message.id === intent.messageId || message.clientRequestId === intent.requestId));
}
