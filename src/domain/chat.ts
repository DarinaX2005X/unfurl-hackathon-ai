import { z } from "zod";
import { ContentLanguageSchema, IdSchema, IsoDateTimeSchema, RevisionSchema } from "./common";
import { CurriculumApprovalSchema, CurriculumDraftSchema } from "./course";
import { ApiErrorDetailSchema } from "./errors";

export const CourseArtifactRefSchema = z.object({
  courseId: IdSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(4_000),
  contentLanguage: ContentLanguageSchema,
  revision: RevisionSchema,
  curriculum: CurriculumDraftSchema.nullable(),
  approval: CurriculumApprovalSchema.nullable(),
  approvalRequestedRevision: RevisionSchema.nullable(),
  readyVersionId: IdSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
}).strict().superRefine((artifact, context) => {
  if (artifact.curriculum && artifact.curriculum.courseId !== artifact.courseId) {
    context.addIssue({ code: "custom", path: ["curriculum", "courseId"], message: "The program must belong to this course" });
  }
});

export const LocalMessageSchema = z.object({
  id: IdSchema, conversationId: IdSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(200_000),
  delivery: z.enum(["not_sent", "sending", "accepted", "failed"]),
  status: z.enum(["complete", "streaming", "interrupted", "failed"]),
  requestId: IdSchema.nullable(), runId: IdSchema.nullable(), branchId: IdSchema.nullable(),
  userLocale: ContentLanguageSchema.nullable(),
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
  error: ApiErrorDetailSchema.nullable(),
}).strict().superRefine((message, context) => {
  if (message.role === "assistant" && message.delivery !== "accepted") {
    context.addIssue({ code: "custom", path: ["delivery"], message: "An assistant message must come from an accepted response" });
  }
  if (message.role === "user" && message.requestId === null) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "A user message needs a stable request identity" });
  }
});

export const LocalConversationSchema = z.object({
  id: IdSchema, schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120), titleSource: z.enum(["initial_text", "user", "legacy"]),
  composerText: z.string().max(20_000),
  messages: z.array(LocalMessageSchema),
  artifacts: z.array(CourseArtifactRefSchema), selectedCourseId: IdSchema.nullable(),
  revision: RevisionSchema,
  createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
  legacySource: z.object({
    draftId: IdSchema, contentLanguage: ContentLanguageSchema,
    updatedAt: IsoDateTimeSchema, intendedConversationId: IdSchema.nullable(),
  }).strict().nullable(),
}).strict().superRefine((conversation, context) => {
  if (conversation.messages.some((message) => message.conversationId !== conversation.id)) {
    context.addIssue({ code: "custom", path: ["messages"], message: "Messages must belong to this conversation" });
  }
  if (new Set(conversation.messages.map((message) => message.id)).size !== conversation.messages.length) {
    context.addIssue({ code: "custom", path: ["messages"], message: "Message identities must be unique" });
  }
  if (new Set(conversation.artifacts.map((artifact) => artifact.courseId)).size !== conversation.artifacts.length) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Course references must be unique" });
  }
  if (conversation.selectedCourseId && !conversation.artifacts.some((artifact) => artifact.courseId === conversation.selectedCourseId)) {
    context.addIssue({ code: "custom", path: ["selectedCourseId"], message: "Select an existing course in this conversation" });
  }
  if (conversation.artifacts.some((artifact) => artifact.curriculum && artifact.curriculum.conversationId !== conversation.id)) {
    context.addIssue({ code: "custom", path: ["artifacts"], message: "Programs must belong to this conversation" });
  }
});

export type LocalMessage = z.infer<typeof LocalMessageSchema>;
export type LocalConversation = z.infer<typeof LocalConversationSchema>;
export type CourseArtifactRef = z.infer<typeof CourseArtifactRefSchema>;
export interface LegacyImportResult { importedIds: string[]; issues: Array<{ draftId?: string; code: "corrupt_record" | "version_unsupported" }> }

export interface ChatStore {
  list(): Promise<LocalConversation[]>;
  get(id: string): Promise<LocalConversation | null>;
  put(conversation: LocalConversation): Promise<void>;
  remove(id: string): Promise<void>;
  wasDeleted(id: string): Promise<boolean>;
  migrateLegacy(): Promise<LegacyImportResult>;
}

export type ChatStoreErrorCode = "unavailable" | "quota_exceeded" | "corrupt_record" | "version_unsupported" | "deleted";
export class ChatStoreError extends Error {
  constructor(readonly code: ChatStoreErrorCode, message: string, readonly conversationId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatStoreError";
  }
}

export interface EditCourseMetadataInput {
  courseId: string;
  expectedRevision: number;
  title: string;
  summary: string;
  contentLanguage: string;
}
export type EditCourseMetadata = (input: EditCourseMetadataInput) => Promise<CourseArtifactRef>;
