import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore } from "../../src/lib/chats";
import type { LocalConversation } from "../../src/domain/chat";
import type { LocalDraft } from "../../src/domain/drafts";
import { ids, timestamp } from "./fixtures";

const databaseName = "chat-migration-tests";
function legacy(id: string = ids.draft): LocalDraft {
  return { id, kind: "course_request", title: "日本語 for my trip", text: "My saved text\nwith a second line.", contentLanguage: "ja", updatedAt: timestamp, schemaVersion: 1, intendedConversationId: ids.conversation };
}
function conversation(): LocalConversation {
  return { id: ids.conversation, schemaVersion: 1, title: "An actual conversation", titleSource: "user", composerText: "A question", messages: [], artifacts: [], selectedCourseId: null,
    revision: 1, createdAt: timestamp, updatedAt: timestamp, legacySource: null };
}
function openRaw(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, version);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("course-drafts")) request.result.createObjectStore("course-drafts", { keyPath: "id" }); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function rawRequest<T>(factory: IDBFactory, name: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openRaw(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(name, mode);
      const request = operation(tx.objectStore(name));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? request.error);
      tx.onerror = () => reject(tx.error ?? request.error);
    });
  } finally { database.close(); }
}
async function seedLegacy(factory: IDBFactory, values: unknown[]) {
  const old = await openRaw(factory, 1);
  old.close();
  for (const value of values) await rawRequest(factory, "course-drafts", "readwrite", (store) => store.put(value));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("chat storage and one-time legacy migration", () => {
  it("imports v1 drafts atomically, retaining exact identity, saved text, title, timestamp and provenance", async () => {
    const factory = new FakeIDBFactory();
    const source = legacy();
    await seedLegacy(factory, [source]);
    const store = createChatStore({ indexedDB: factory, databaseName });
    expect(await store.migrateLegacy()).toEqual({ importedIds: [source.id], issues: [] });
    const imported = await store.get(source.id);
    expect(imported).toEqual({ id: source.id, schemaVersion: 1, title: source.title, titleSource: "legacy", composerText: source.text, messages: [], artifacts: [], selectedCourseId: null,
      revision: 1, createdAt: source.updatedAt, updatedAt: source.updatedAt,
      legacySource: { draftId: source.id, contentLanguage: "ja", updatedAt: source.updatedAt, intendedConversationId: ids.conversation } });
    expect(await rawRequest(factory, "course-drafts", "readonly", (raw) => raw.get(source.id))).toEqual(source);
    const reloaded = createChatStore({ indexedDB: factory, databaseName });
    expect(await reloaded.migrateLegacy()).toEqual({ importedIds: [], issues: [] });
    expect(await reloaded.list()).toEqual([imported]);
  });

  it("does not overwrite edits on repeated import or resurrect a deleted chat from the legacy record", async () => {
    const factory = new FakeIDBFactory();
    await seedLegacy(factory, [legacy(), legacy(ids.sample)]);
    const store = createChatStore({ indexedDB: factory, databaseName });
    const original = (await store.get(ids.draft))!;
    const changed = { ...original, composerText: "My later edits", title: "Renamed chat", titleSource: "user" as const, revision: 2 };
    await store.put(changed);
    expect(await createChatStore({ indexedDB: factory, databaseName }).get(ids.draft)).toEqual(changed);
    await store.remove(ids.draft);
    const reopened = createChatStore({ indexedDB: factory, databaseName });
    expect(await reopened.get(ids.draft)).toBeNull();
    expect(await reopened.wasDeleted(ids.draft)).toBe(true);
    expect((await reopened.list()).map((item) => item.id)).toEqual([ids.sample]);
    await expect(reopened.put({ ...changed, revision: 3 })).rejects.toMatchObject({ code: "deleted" });
    expect(await reopened.get(ids.draft)).toBeNull();
    expect(await rawRequest(factory, "course-drafts", "readonly", (raw) => raw.get(ids.draft))).toEqual(legacy());
  });

  it("reports corrupt and future legacy records while preserving them and importing valid neighbors", async () => {
    const factory = new FakeIDBFactory();
    const corrupt = { ...legacy(), title: 42 };
    const future = { ...legacy(ids.missing), schemaVersion: 3, unknown: "keep" };
    const valid = legacy(ids.sample);
    await seedLegacy(factory, [corrupt, future, valid]);
    const store = createChatStore({ indexedDB: factory, databaseName });
    const result = await store.migrateLegacy();
    expect(result.importedIds).toEqual([ids.sample]);
    expect(result.issues).toEqual(expect.arrayContaining([{ draftId: ids.draft, code: "corrupt_record" }, { draftId: ids.missing, code: "version_unsupported" }]));
    expect(await rawRequest(factory, "course-drafts", "readonly", (raw) => raw.get(ids.draft))).toEqual(corrupt);
    expect(await rawRequest(factory, "course-drafts", "readonly", (raw) => raw.get(ids.missing))).toEqual(future);
    expect((await store.list()).map((item) => item.id)).toEqual([ids.sample]);
  });

  it("rolls back both imported data and markers on quota failure, then retries safely", async () => {
    const factory = new FakeIDBFactory();
    await seedLegacy(factory, [legacy()]);
    const store = createChatStore({ indexedDB: factory, databaseName });
    const quota = new DOMException("Full", "QuotaExceededError");
    const originalPut = FakeObjectStore.prototype.put;
    const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "legacy-conversation-imports") throw quota;
      return originalPut.call(this, value, key);
    });
    await expect(store.migrateLegacy()).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await rawRequest(factory, "conversations", "readonly", (raw) => raw.getAll())).toEqual([]);
    expect(await rawRequest(factory, "legacy-conversation-imports", "readonly", (raw) => raw.getAll())).toEqual([]);
    put.mockRestore();
    expect((await store.migrateLegacy()).importedIds).toEqual([ids.draft]);
  });

  it("acknowledges only completed writes and preserves the old chat after a quota failure", async () => {
    const factory = new FakeIDBFactory();
    const store = createChatStore({ indexedDB: factory, databaseName });
    const saved = conversation();
    await store.put(saved);
    expect(await createChatStore({ indexedDB: factory, databaseName }).get(saved.id)).toEqual(saved);
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("Full", "QuotaExceededError"); });
    await expect(store.put({ ...saved, composerText: "New text", revision: 2 })).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it("reports unavailable browser storage without creating any records", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = createChatStore({ databaseName });
    await expect(store.list()).rejects.toMatchObject({ code: "unavailable" });
  });
});
