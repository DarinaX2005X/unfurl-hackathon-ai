import { LocalConversationSchema, type LocalConversation } from "@/domain/chat";

export interface ChatRecovery {
  read(id: string): LocalConversation | null;
  write(conversation: LocalConversation): void;
  clear(id: string): void;
}

/** A synchronous recovery copy protects edits while IndexedDB acknowledges its transaction. */
export function createChatRecovery(storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): ChatRecovery {
  const memory = new Map<string, LocalConversation>();
  const key = (id: string) => `unfurl:chat-recovery:${id}`;
  return {
    read(id) {
      if (memory.has(id)) return memory.get(id)!;
      try {
        const value = storage?.().getItem(key(id));
        if (!value) return null;
        const result = LocalConversationSchema.safeParse(JSON.parse(value));
        if (!result.success || result.data.id !== id) return null;
        memory.set(id, result.data);
        return result.data;
      } catch { return null; }
    },
    write(conversation) {
      memory.set(conversation.id, conversation);
      try { storage?.().setItem(key(conversation.id), JSON.stringify(conversation)); } catch { /* IndexedDB remains authoritative; failures never claim a saved chat. */ }
    },
    clear(id) {
      memory.delete(id);
      try { storage?.().removeItem(key(id)); } catch { /* Database revisions and tombstones reject stale recovery copies. */ }
    },
  };
}

export const tabChatRecovery = createChatRecovery(() => window.sessionStorage);
