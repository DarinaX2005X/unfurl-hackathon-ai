import { z } from "zod";
import { ContentLanguageSchema, IdSchema, IsoDateTimeSchema, RevisionSchema, pageSchema } from "./common";
import { CourseArtifactRefSchema } from "./chat";
import { AgentTurnRunSchema, ChatMessageSchema, ConversationSchema } from "./generation";

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

export const ConversationDetailSchema = z.object({
  conversation: ConversationSchema,
  messages: z.array(ChatMessageSchema),
  activeTurn: AgentTurnRunSchema.nullable(),
  artifacts: z.array(CourseArtifactRefSchema),
  composerDraft: ComposerDraftSchema,
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
  if (new Set(artifacts.map((artifact) => artifact.courseId)).size !== artifacts.length
    || artifacts.some((artifact) => artifact.curriculum && artifact.curriculum.conversationId !== conversation.id)) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Course references must belong to this chat" });
  }
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;
export const ConversationPageSchema = pageSchema(ConversationSchema);

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
