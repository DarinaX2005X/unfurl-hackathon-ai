import { z } from "zod";
import {
  ContentLanguageSchema, CourseSummarySchema, IdSchema, IsoDateTimeSchema,
  type ApiError, type ChatMessage, type ContentLanguage, type CourseDetailPublic,
  type CourseSummary, type GenerationRun, type Id, type Page,
} from "../domain";

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

export const StartGenerationInputSchema = z.object({
  requestId: IdSchema,
  draftId: IdSchema.nullable(),
  text: z.string().trim().min(1).max(20_000),
  contentLanguage: ContentLanguageSchema,
}).strict();
export interface StartGenerationInput {
  requestId: Id;
  draftId: Id | null;
  text: string;
  contentLanguage: ContentLanguage;
}
export interface StartGenerationResult {
  message: ChatMessage;
  run: GenerationRun;
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
  startGeneration(input: StartGenerationInput, signal?: AbortSignal): Promise<ServiceResult<StartGenerationResult>>;
}
