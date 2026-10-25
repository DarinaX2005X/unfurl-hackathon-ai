import { z } from "zod";
import {
  ContentLanguageSchema, CourseSummarySchema, IdSchema, IsoDateTimeSchema,
  type ApiError, type ChatMessage, type CourseDetailPublic,
  type CourseSummary, type AgentTurnRun, type Page,
} from "../domain";
import { CloudSendMessageInputSchema, type CloudSendMessageInput } from "../domain/conversations";

export interface CapabilitySet {
  generation: boolean;
  cloudIdentity: boolean;
  cloudPersistence: boolean;
}
export const CourseQuerySchema = z.object({
  q: z.string().max(200).optional(),
  contentLanguage: ContentLanguageSchema.optional(),
  cursor: z.string().max(2_000).optional(),
  limit: z.number().int().min(1).max(60).optional(),
}).strict();
export type CourseQuery = z.infer<typeof CourseQuerySchema>;
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const SendMessageInputSchema = CloudSendMessageInputSchema;
export type SendMessageInput = CloudSendMessageInput;
export interface SendMessageResult {
  message: ChatMessage;
  run: AgentTurnRun;
}

export const LibraryItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owned"), course: CourseSummarySchema }).strict(),
  z.object({
    kind: z.literal("enrolled"), course: CourseSummarySchema,
    enrollmentId: IdSchema, lastStudiedAt: IsoDateTimeSchema.nullable(),
  }).strict(),
]);
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export interface ApplicationPort {
  capabilities(): Promise<CapabilitySet>;
  listPublic(query: CourseQuery, signal?: AbortSignal): Promise<ServiceResult<Page<CourseSummary>>>;
  getPublicCourse(slug: string, signal?: AbortSignal): Promise<ServiceResult<CourseDetailPublic>>;
  listLibrary(signal?: AbortSignal): Promise<ServiceResult<Page<LibraryItem>>>;
  sendMessage(input: SendMessageInput, signal?: AbortSignal): Promise<ServiceResult<SendMessageResult>>;
}
