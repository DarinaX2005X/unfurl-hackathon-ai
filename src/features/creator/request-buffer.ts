import { ContentLanguageSchema } from "@/domain/common";

export interface RequestBufferValue { text: string; contentLanguage: string; baseUpdatedAt: string | null }
export interface RequestBuffer {
  read(key: string): RequestBufferValue | null;
  write(key: string, value: RequestBufferValue): void;
  clear(key: string): void;
}

/** Tab recovery is separate from saved drafts and never populates the library. */
export function createRequestBuffer(storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): RequestBuffer {
  const memory = new Map<string, RequestBufferValue>();
  const name = (key: string) => `unfurl:request-buffer:${key}`;
  return {
    read(key) {
      if (memory.has(key)) return memory.get(key)!;
      try {
        const raw = storage?.().getItem(name(key));
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null) return null;
        const item = value as Record<string, unknown>;
        if (typeof item.text !== "string" || item.text.length > 20_000 || !ContentLanguageSchema.safeParse(item.contentLanguage).success
          || (item.baseUpdatedAt !== null && typeof item.baseUpdatedAt !== "string")) return null;
        const result: RequestBufferValue = { text: item.text, contentLanguage: item.contentLanguage as string, baseUpdatedAt: item.baseUpdatedAt as string | null };
        memory.set(key, result);
        return result;
      } catch { return null; }
    },
    write(key, value) {
      memory.set(key, value);
      try { storage?.().setItem(name(key), JSON.stringify(value)); } catch { /* The editor remains unsaved; memory survives route changes. */ }
    },
    clear(key) {
      memory.delete(key);
      try { storage?.().removeItem(name(key)); } catch { /* A saved record remains authoritative. */ }
    },
  };
}

export const tabRequestBuffer = createRequestBuffer(() => window.sessionStorage);
