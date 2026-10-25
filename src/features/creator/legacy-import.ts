import type { LocalConversation } from "@/domain/chat";
import { ImportConversationInputSchema, type ImportConversationInput } from "@/domain/conversations";

/** Old replies and artifacts stay in the original browser record; only user input crosses this boundary. */
export function localConversationImport(source: LocalConversation): ImportConversationInput {
  return ImportConversationInputSchema.parse({
    sourceId: source.id, sourceRevision: source.revision, title: source.title, composerText: source.composerText,
    userMessages: source.messages.filter((message) => message.role === "user").map((message) => ({
      sourceMessageId: message.id, text: message.text, sourceCreatedAt: message.createdAt,
      ...(message.userLocale ? { userLocale: message.userLocale } : {}),
    })),
    sourceCreatedAt: source.createdAt, sourceUpdatedAt: source.updatedAt,
    ...(source.legacySource ? { legacySource: { draftId: source.legacySource.draftId, contentLanguage: source.legacySource.contentLanguage } } : {}),
  });
}
