import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, RevisionSchema } from "@/domain/common";
import { CloudSendMessageInputSchema, CreateConversationInputSchema, PendingUserMessagesSchema, SaveComposerInputSchema } from "@/domain/conversations";

/** Only user input and its retry identities may enter this emergency buffer. */
export const ChatRecoveryBufferSchema = z.object({
  actorId: IdSchema,
  conversationId: IdSchema.nullable(),
  text: z.string().max(20_000),
  pendingMessages: PendingUserMessagesSchema,
  baseComposerRevision: RevisionSchema.nullable(),
  conflicted: z.boolean(),
  createCommand: z.object({ key: IdSchema, input: CreateConversationInputSchema }).strict().nullable(),
  saveCommand: z.object({ key: IdSchema, input: SaveComposerInputSchema }).strict().nullable(),
  sendCommand: CloudSendMessageInputSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
}).strict();
export type ChatRecoveryBuffer = z.infer<typeof ChatRecoveryBufferSchema>;
export interface ChatRecovery {
  read(actorId: string, conversationId: string | null): ChatRecoveryBuffer | null;
  write(buffer: ChatRecoveryBuffer): void;
  clear(actorId: string, conversationId: string | null): void;
  forgetActor(actorId: string): void;
}

export function createChatRecovery(storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): ChatRecovery {
  const memory = new Map<string, ChatRecoveryBuffer>();
  const key = (actorId: string, id: string | null) => `unfurl:account-chat-input:${actorId}:${id ?? "new"}`;
  return {
    read(actorId, id) {
      const name = key(actorId, id);
      if (memory.has(name)) return memory.get(name)!;
      try {
        const value = storage?.().getItem(name);
        if (!value) return null;
        const parsed = ChatRecoveryBufferSchema.safeParse(JSON.parse(value));
        if (!parsed.success || parsed.data.actorId !== actorId || parsed.data.conversationId !== id) return null;
        memory.set(name, parsed.data);
        return parsed.data;
      } catch { return null; }
    },
    write(buffer) {
      const parsed = ChatRecoveryBufferSchema.safeParse(buffer);
      if (!parsed.success) return;
      const name = key(buffer.actorId, buffer.conversationId);
      memory.set(name, parsed.data);
      try { storage?.().setItem(name, JSON.stringify(parsed.data)); } catch { /* An emergency buffer never establishes a server save. */ }
    },
    clear(actorId, id) {
      const name = key(actorId, id);
      memory.delete(name);
      try { storage?.().removeItem(name); } catch { /* Canonical reads still detect a stale buffer. */ }
    },
    forgetActor(actorId) {
      for (const name of memory.keys()) if (name.startsWith(`unfurl:account-chat-input:${actorId}:`)) memory.delete(name);
    },
  };
}

export const tabChatRecovery = createChatRecovery(() => window.sessionStorage);
