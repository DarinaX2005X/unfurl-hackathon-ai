import { IdSchema } from "@/domain/common";
import { LocalDraftSchema } from "@/domain/drafts";
import { ChatStoreError, LocalConversationSchema, type ChatStore, type LegacyImportResult, type LocalConversation } from "@/domain/chat";

export { ChatStoreError, type ChatStore, type LocalConversation } from "@/domain/chat";

const CONVERSATIONS = "conversations";
const TOMBSTONES = "conversation-tombstones";
const IMPORTS = "legacy-conversation-imports";
const LEGACY = "course-drafts";

function asError(error: unknown, id?: string): ChatStoreError {
  if (error instanceof ChatStoreError) return error;
  const name = error instanceof Error ? error.name : "";
  return new ChatStoreError(name === "QuotaExceededError" ? "quota_exceeded" : name === "VersionError" ? "version_unsupported" : "unavailable", "Chat storage could not complete this operation", id, { cause: error });
}

function readConversation(value: unknown, id?: string): LocalConversation {
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion !== 1) {
    throw new ChatStoreError("version_unsupported", "This chat uses a newer format", id);
  }
  const parsed = LocalConversationSchema.safeParse(value);
  if (!parsed.success || (id !== undefined && parsed.data.id !== id)) throw new ChatStoreError("corrupt_record", "This chat could not be read", id);
  return parsed.data;
}

export function createChatStore(options: { indexedDB?: IDBFactory; databaseName?: string } = {}): ChatStore {
  let connection: Promise<IDBDatabase> | null = null;
  let importing: Promise<LegacyImportResult> | null = null;
  const databaseName = options.databaseName ?? "unfurl-local";

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new ChatStoreError("unavailable", "Chat storage is unavailable")); return; }
      let request: IDBOpenDBRequest;
      let blocked = false;
      try { request = factory.open(databaseName, 2); } catch (error) { reject(asError(error)); return; }
      request.onupgradeneeded = () => {
        for (const name of [LEGACY, CONVERSATIONS, TOMBSTONES, IMPORTS]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
        }
      };
      request.onerror = () => reject(asError(request.error));
      request.onblocked = () => { blocked = true; reject(new ChatStoreError("unavailable", "Another tab is preventing chat storage from opening")); };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) { database.close(); return; }
        database.onversionchange = () => { database.close(); connection = null; importing = null; };
        resolve(database);
      };
    }).catch((error: unknown) => { connection = null; throw asError(error); });
    return connection;
  }

  async function transact<T>(names: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void, id?: string): Promise<T> {
    try {
      const database = await open();
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction(names, mode);
        let result: T;
        let failure: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(asError(failure ?? tx.error, id));
        tx.onerror = () => reject(asError(failure ?? tx.error, id));
        try { operation(tx, (value) => { result = value; }, (error) => { failure = error; tx.abort(); }); }
        catch (error) { failure = error; tx.abort(); }
      });
    } catch (error) { throw asError(error, id); }
  }

  function migrateLegacy(): Promise<LegacyImportResult> {
    if (importing) return importing;
    importing = transact<LegacyImportResult>([LEGACY, CONVERSATIONS, TOMBSTONES, IMPORTS], "readwrite", (tx, done, fail) => {
      const result: LegacyImportResult = { importedIds: [], issues: [] };
      done(result);
      const request = tx.objectStore(LEGACY).getAll();
      request.onsuccess = () => {
        for (const raw of request.result as unknown[]) {
          const parsed = LocalDraftSchema.safeParse(raw);
          if (!parsed.success) {
            const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
            result.issues.push({ ...(typeof source.id === "string" ? { draftId: source.id } : {}), code: source.schemaVersion !== undefined && source.schemaVersion !== 1 ? "version_unsupported" : "corrupt_record" });
            continue;
          }
          const draft = parsed.data;
          const tombstone = tx.objectStore(TOMBSTONES).get(draft.id);
          tombstone.onsuccess = () => {
            if (tombstone.result) return;
            const marker = tx.objectStore(IMPORTS).get(draft.id);
            marker.onsuccess = () => {
              if (marker.result) return;
              const existing = tx.objectStore(CONVERSATIONS).get(draft.id);
              existing.onsuccess = () => {
                try {
                if (!existing.result) {
                  const conversation: LocalConversation = {
                    id: draft.id, schemaVersion: 1, title: draft.title, titleSource: "legacy", composerText: draft.text,
                    messages: [], artifacts: [], selectedCourseId: null, revision: 1,
                    createdAt: draft.updatedAt, updatedAt: draft.updatedAt,
                    legacySource: { draftId: draft.id, contentLanguage: draft.contentLanguage, updatedAt: draft.updatedAt, intendedConversationId: draft.intendedConversationId },
                  };
                  tx.objectStore(CONVERSATIONS).put(conversation);
                  result.importedIds.push(draft.id);
                }
                tx.objectStore(IMPORTS).put({ id: draft.id, importedAt: new Date().toISOString(), sourceUpdatedAt: draft.updatedAt });
                } catch (error) { fail(error); }
              };
            };
          };
        }
      };
    }).catch((error: unknown) => { importing = null; throw error; });
    return importing;
  }

  return {
    migrateLegacy,
    async list() {
      await migrateLegacy();
      return transact<LocalConversation[]>([CONVERSATIONS], "readonly", (tx, done, fail) => {
        const request = tx.objectStore(CONVERSATIONS).getAll();
        request.onsuccess = () => {
          try { done((request.result as unknown[]).map((value) => readConversation(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))); }
          catch (error) { fail(error); }
        };
      });
    },
    async get(id) {
      IdSchema.parse(id);
      await migrateLegacy();
      return transact<LocalConversation | null>([CONVERSATIONS], "readonly", (tx, done, fail) => {
        const request = tx.objectStore(CONVERSATIONS).get(id);
        request.onsuccess = () => { try { done(request.result === undefined ? null : readConversation(request.result, id)); } catch (error) { fail(error); } };
      }, id);
    },
    async put(conversation) {
      const validated = LocalConversationSchema.parse(conversation);
      await transact<void>([CONVERSATIONS, TOMBSTONES], "readwrite", (tx, done, fail) => {
        const request = tx.objectStore(TOMBSTONES).get(validated.id);
        request.onsuccess = () => {
          try {
          if (request.result) { fail(new ChatStoreError("deleted", "This chat was deleted", validated.id)); return; }
          tx.objectStore(CONVERSATIONS).put(validated);
          done(undefined);
          } catch (error) { fail(error); }
        };
      }, validated.id);
    },
    async remove(id) {
      IdSchema.parse(id);
      await transact<void>([CONVERSATIONS, TOMBSTONES], "readwrite", (tx, done) => {
        tx.objectStore(CONVERSATIONS).delete(id);
        tx.objectStore(TOMBSTONES).put({ id, deletedAt: new Date().toISOString() });
        done(undefined);
      }, id);
    },
    async wasDeleted(id) {
      IdSchema.parse(id);
      return transact<boolean>([TOMBSTONES], "readonly", (tx, done) => {
        const request = tx.objectStore(TOMBSTONES).get(id);
        request.onsuccess = () => done(Boolean(request.result));
      }, id);
    },
  };
}

export const chatStore = createChatStore();
