import { z } from "zod";
import { ContentLanguageSchema, IdSchema, IsoDateTimeSchema } from "./common";

export const LocalDraftSchema = z.object({
  id: IdSchema,
  kind: z.literal("course_request"),
  title: z.string().trim().min(1).max(120),
  text: z.string().max(20_000),
  contentLanguage: ContentLanguageSchema,
  updatedAt: IsoDateTimeSchema,
  schemaVersion: z.literal(1),
  intendedConversationId: IdSchema.nullable(),
}).strict();
export type LocalDraft = z.infer<typeof LocalDraftSchema>;

export interface DraftStore {
  list(): Promise<LocalDraft[]>;
  get(id: string): Promise<LocalDraft | null>;
  put(draft: LocalDraft): Promise<void>;
  remove(id: string): Promise<void>;
}

export type StorageErrorCode = "unavailable" | "quota_exceeded" | "corrupt_record" | "version_unsupported";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly draftId: string | undefined;

  constructor(code: StorageErrorCode, message: string, options?: { draftId?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    this.draftId = options?.draftId;
  }
}
