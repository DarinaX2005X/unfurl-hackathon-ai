import { IdSchema } from "../domain/common";
import { LocalDraftSchema, StorageError, type DraftStore, type LocalDraft } from "../domain/drafts";

export { LocalDraftSchema, StorageError, type DraftStore, type LocalDraft } from "../domain/drafts";

const STORE_NAME = "course-drafts";
const DATABASE_VERSION = 1;

function storageError(error: unknown, draftId?: string): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof Error ? error.name : "";
  const code = name === "QuotaExceededError" ? "quota_exceeded" : name === "VersionError" ? "version_unsupported" : "unavailable";
  return new StorageError(code, "The local draft could not be stored or read", {
    ...(draftId === undefined ? {} : { draftId }), cause: error,
  });
}

function readRecord(value: unknown, requestedId?: string): LocalDraft {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const draftId = typeof record?.id === "string" ? record.id : requestedId;
  const options = draftId === undefined ? undefined : { draftId };
  if (record?.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new StorageError("version_unsupported", "This draft uses an unsupported storage version", options);
  }
  const parsed = LocalDraftSchema.safeParse(value);
  if (!parsed.success) throw new StorageError("corrupt_record", "This draft could not be read safely", options);
  return parsed.data;
}

export function createDraftStore(options: { indexedDB?: IDBFactory; databaseName?: string } = {}): DraftStore {
  let connection: Promise<IDBDatabase> | null = null;
  const databaseName = options.databaseName ?? "unfurl-local";

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) {
        reject(new StorageError("unavailable", "Local draft storage is not available in this browser"));
        return;
      }
      let request: IDBOpenDBRequest;
      let blocked = false;
      try {
        request = factory.open(databaseName, DATABASE_VERSION);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(new StorageError("unavailable", "Another tab is preventing local storage from opening"));
      };
      request.onerror = () => reject(storageError(request.error));
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) { database.close(); return; }
        database.onversionchange = () => { database.close(); connection = null; };
        resolve(database);
      };
    }).catch((error: unknown) => {
      connection = null;
      throw storageError(error);
    });
    return connection;
  }

  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
    draftId?: string,
  ): Promise<T> {
    try {
      const database = await open();
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode);
        let request: IDBRequest<T>;
        try {
          request = operation(tx.objectStore(STORE_NAME));
        } catch (error) {
          tx.abort();
          reject(storageError(error, draftId));
          return;
        }
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(storageError(tx.error ?? request.error, draftId));
        tx.onerror = () => reject(storageError(tx.error ?? request.error, draftId));
      });
    } catch (error) {
      throw storageError(error, draftId);
    }
  }

  return {
    async list() {
      const records: unknown[] = await transaction("readonly", (store) => store.getAll());
      return records.map((record) => readRecord(record)).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },
    async get(id) {
      IdSchema.parse(id);
      const record: unknown = await transaction("readonly", (store) => store.get(id), id);
      return record === undefined ? null : readRecord(record, id);
    },
    async put(draft) {
      const validated = LocalDraftSchema.parse(draft);
      await transaction("readwrite", (store) => store.put(validated), validated.id);
    },
    async remove(id) {
      IdSchema.parse(id);
      await transaction("readwrite", (store) => store.delete(id), id);
    },
  };
}

export const draftStore = createDraftStore();
