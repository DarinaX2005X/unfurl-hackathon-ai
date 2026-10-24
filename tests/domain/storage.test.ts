import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { StorageError, type DraftStore, type LocalDraft } from "../../src/domain/drafts";
import { createDraftStore } from "../../src/lib/drafts";

const databaseName = "draft-storage-tests";
const storeName = "course-drafts";
const selectedId = "87441d3c-66a6-4ff7-913c-a02604681487";
const neighborId = "50c2e75d-63c9-48cf-b224-d031bf3f84a1";
const conversationId = "bb403237-ebc3-4fb0-81af-7e33433d7dc5";

function draft(overrides: Partial<LocalDraft> = {}): LocalDraft {
  return {
    id: selectedId,
    kind: "course_request",
    title: "Japanese foundations",
    text: "Teach me how to introduce myself in Japanese.",
    contentLanguage: "ja",
    updatedAt: "2026-10-24T08:00:00.000Z",
    schemaVersion: 1,
    intendedConversationId: conversationId,
    ...overrides,
  };
}

function openRaw(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function rawRequest<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openRaw(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
      transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  } finally {
    database.close();
  }
}

const readRaw = (factory: IDBFactory): Promise<unknown[]> =>
  rawRequest(factory, "readonly", (store) => store.getAll());

describe("local draft storage", () => {
  let factory: IDBFactory;
  let store: DraftStore;

  beforeEach(() => {
    factory = new FakeIDBFactory();
    store = createDraftStore({ indexedDB: factory, databaseName });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists an empty library and reads a missing draft without creating one", async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.get(selectedId)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await readRaw(factory)).toEqual([]);
  });

  it("persists complete drafts across a new store instance and lists recent edits first", async () => {
    const first = draft();
    const recent = draft({
      id: neighborId,
      title: "New course",
      text: "",
      updatedAt: "2026-10-24T09:00:00.000Z",
      intendedConversationId: null,
    });
    await store.put(first);
    await store.put(recent);

    const reloaded = createDraftStore({ indexedDB: factory, databaseName });
    expect(await reloaded.get(selectedId)).toEqual(first);
    expect(await reloaded.get(neighborId)).toEqual(recent);
    expect(await reloaded.list()).toEqual([recent, first]);
  });

  it("renames and deletes only the selected draft while preserving its neighbor", async () => {
    const selected = draft();
    const neighbor = draft({ id: neighborId, title: "Spanish foundations", contentLanguage: "es" });
    await store.put(selected);
    await store.put(neighbor);

    const renamed = { ...selected, title: "Japanese greetings", updatedAt: "2026-10-24T10:00:00.000Z" };
    await store.put(renamed);
    expect(await store.get(selectedId)).toEqual(renamed);
    expect(await store.get(neighborId)).toEqual(neighbor);
    expect(await readRaw(factory)).toHaveLength(2);

    await store.remove(selectedId);
    const reloaded = createDraftStore({ indexedDB: factory, databaseName });
    expect(await reloaded.get(selectedId)).toBeNull();
    expect(await reloaded.list()).toEqual([neighbor]);
    expect(await readRaw(factory)).toEqual([neighbor]);
  });

  it.each([
    { label: "corrupt", overrides: { title: 42 }, code: "corrupt_record" },
    { label: "future-version", overrides: { schemaVersion: 2, futureContent: { preserved: true } }, code: "version_unsupported" },
  ])("reports a $label record without deleting or rewriting stored data", async ({ overrides, code }) => {
    const unreadable = { ...draft(), ...overrides };
    const neighbor = draft({ id: neighborId });
    await rawRequest(factory, "readwrite", (rawStore) => rawStore.put(unreadable));
    await rawRequest(factory, "readwrite", (rawStore) => rawStore.put(neighbor));
    const before = await readRaw(factory);

    await expect(store.get(selectedId)).rejects.toBeInstanceOf(StorageError);
    await expect(store.get(selectedId)).rejects.toMatchObject({ code, draftId: selectedId });
    await expect(store.list()).rejects.toMatchObject({ name: "StorageError", code, draftId: selectedId });
    expect(await store.get(neighborId)).toEqual(neighbor);
    expect(await readRaw(factory)).toEqual(before);
  });

  it("reports an unsupported database version while leaving its records intact", async () => {
    const database = await openRaw(factory, 2);
    database.close();
    const retained = draft();
    await rawRequest(factory, "readwrite", (rawStore) => rawStore.put(retained));

    await expect(store.list()).rejects.toBeInstanceOf(StorageError);
    await expect(store.list()).rejects.toMatchObject({ code: "version_unsupported" });
    expect(await readRaw(factory)).toEqual([retained]);
  });

  it("returns a typed unavailable error when the browser has no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const unavailable = createDraftStore({ databaseName });
    await expect(unavailable.list()).rejects.toBeInstanceOf(StorageError);
    await expect(unavailable.list()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("returns a typed unavailable error when the browser denies database access", async () => {
    const denied = new DOMException("Storage access denied", "SecurityError");
    vi.spyOn(factory, "open").mockImplementation(() => { throw denied; });

    await expect(store.put(draft())).rejects.toBeInstanceOf(StorageError);
    await expect(store.put(draft())).rejects.toMatchObject({ code: "unavailable", cause: denied });
  });

  it("preserves the saved draft on quota failure and allows a later retry", async () => {
    const saved = draft();
    await store.put(saved);
    const edited = { ...saved, text: "An expanded course request" };
    const quota = new DOMException("Storage quota exceeded", "QuotaExceededError");
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(() => { throw quota; });

    const failedWrite = store.put(edited);
    await expect(failedWrite).rejects.toBeInstanceOf(StorageError);
    await expect(failedWrite).rejects.toMatchObject({ code: "quota_exceeded", draftId: selectedId, cause: quota });
    expect(await readRaw(factory)).toEqual([saved]);

    await store.put(edited);
    expect(await store.get(selectedId)).toEqual(edited);
  });

  it.each([
    { label: "blank title", overrides: { title: "   " } },
    { label: "oversized request", overrides: { text: "x".repeat(20_001) } },
    { label: "invalid identifier", overrides: { id: "not-a-uuid" } },
    { label: "non-UTC timestamp", overrides: { updatedAt: "2026-10-24T13:00:00+05:00" } },
    { label: "unsupported schema", overrides: { schemaVersion: 2 } },
    { label: "unknown field", overrides: { published: true } },
  ])("rejects a $label before opening storage or writing", async ({ overrides }) => {
    const open = vi.spyOn(factory, "open");
    const invalid = { ...draft(), ...overrides } as unknown as LocalDraft;

    await expect(store.put(invalid)).rejects.toBeInstanceOf(ZodError);
    expect(open).not.toHaveBeenCalled();
    expect(await readRaw(factory)).toEqual([]);
  });

  it("rejects invalid read and delete identifiers before touching a saved draft", async () => {
    const saved = draft();
    await store.put(saved);

    await expect(store.get("invalid-id")).rejects.toBeInstanceOf(ZodError);
    await expect(store.remove("invalid-id")).rejects.toBeInstanceOf(ZodError);
    expect(await readRaw(factory)).toEqual([saved]);
  });
});
