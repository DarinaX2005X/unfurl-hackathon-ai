import type { Conversation, Id, Page } from "../domain";
import type {
  ComposerDraft, ConversationDetail, ConversationQuery, CreateConversationInput,
  ConversationActionPage, ConversationActionQuery,
  DeleteConversationInput, ImportConversationInput, ImportConversationResult,
  RenameConversationInput, SaveComposerInput,
} from "../domain/conversations";
import type { ServiceResult } from "./ports";

/** Only user-owned text can be written through this boundary. */
export interface ConversationPort {
  list(query?: ConversationQuery, signal?: AbortSignal): Promise<ServiceResult<Page<Conversation>>>;
  get(id: Id, signal?: AbortSignal): Promise<ServiceResult<ConversationDetail>>;
  getActions(id: Id, query?: ConversationActionQuery, signal?: AbortSignal): Promise<ServiceResult<ConversationActionPage>>;
  create(input: CreateConversationInput, key: Id, signal?: AbortSignal): Promise<ServiceResult<ConversationDetail>>;
  rename(id: Id, input: RenameConversationInput, key: Id, signal?: AbortSignal): Promise<ServiceResult<Conversation>>;
  saveComposer(id: Id, input: SaveComposerInput, key: Id, signal?: AbortSignal): Promise<ServiceResult<ComposerDraft>>;
  remove(id: Id, input: DeleteConversationInput, key: Id, signal?: AbortSignal): Promise<ServiceResult<null>>;
  importLocal(input: ImportConversationInput, key: Id, signal?: AbortSignal): Promise<ServiceResult<ImportConversationResult>>;
}
