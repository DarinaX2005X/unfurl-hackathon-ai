import { describe, expect, it, vi } from "vitest";
import { DraftEditor, appendQuickAction, draftTitle, REQUEST_LIMIT } from "../../src/features/creator/draft-editor";
import { createRequestBuffer } from "../../src/features/creator/request-buffer";
import { StorageError, type DraftStore, type LocalDraft } from "../../src/domain/drafts";

const id = "20000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const time = "2026-10-24T12:00:00.000Z";
const later = "2026-10-24T12:01:00.000Z";
const record = (): LocalDraft => ({ id, kind: "course_request", title: "My own title", text: "Understand AI from the basics, then learn model building and AI systems.", contentLanguage: "ru", updatedAt: time, schemaVersion: 1, intendedConversationId: null });

function memoryStore(records: LocalDraft[] = []): DraftStore {
  const saved = new Map(records.map((draft) => [draft.id, draft]));
  return { list: vi.fn(async () => [...saved.values()]), get: vi.fn(async (key) => saved.get(key) ?? null), put: vi.fn(async (draft) => { saved.set(draft.id, draft); }), remove: vi.fn(async (key) => { saved.delete(key); }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("creator draft lifecycle", () => {
  it("does not create a saved record by opening or editing a new request", async () => {
    const store = memoryStore();
    const editor = new DraftEditor(store, null, () => id, () => time);
    await editor.open();
    editor.edit({ text: record().text, contentLanguage: "ru" });
    expect(editor.getSnapshot().saveStatus).toBe("unsaved");
    expect(store.put).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    const saved = await editor.save();
    expect(saved).toMatchObject({ id, text: record().text, contentLanguage: "ru" });
    expect(editor.getSnapshot().saveStatus).toBe("saved");
    expect(saved?.title).toBe(draftTitle(record().text));
  });

  it("marks a save only after acknowledgement and queues edits made during the write", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const store = memoryStore();
    vi.mocked(store.put).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const editor = new DraftEditor(store, null, () => id, () => time);
    editor.edit({ text: "First version" });
    const writing = editor.save();
    expect(editor.getSnapshot().saveStatus).toBe("saving");
    expect(editor.getSnapshot().savedDraft).toBeNull();
    editor.edit({ text: "A later, more specific outcome", contentLanguage: "kk" });
    expect(editor.save()).toBe(writing);
    first.resolve();
    await Promise.resolve();
    expect(editor.getSnapshot().saveStatus).toBe("saving");
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.put).mock.calls[1]?.[0]).toMatchObject({ id, text: "A later, more specific outcome", contentLanguage: "kk" });
    second.resolve();
    await writing;
    expect(editor.getSnapshot().saveStatus).toBe("saved");
    expect(editor.getSnapshot().savedDraft?.text).toBe("A later, more specific outcome");
  });

  it("keeps text and save identity when storage fails, then retries the same record", async () => {
    const store = memoryStore();
    vi.mocked(store.put).mockRejectedValueOnce(new StorageError("quota_exceeded", "Full"));
    const createId = vi.fn(() => id);
    const editor = new DraftEditor(store, null, createId, () => time);
    editor.edit({ text: record().text });
    expect(await editor.save()).toBeNull();
    expect(editor.getSnapshot()).toMatchObject({ text: record().text, saveStatus: "error", savedDraft: null, error: { code: "quota_exceeded" } });
    expect(await editor.save()).toMatchObject({ id });
    expect(createId).toHaveBeenCalledTimes(1);
    expect(editor.getSnapshot().saveStatus).toBe("saved");
  });

  it("reopens the exact record and preserves its title while editing and changing language", async () => {
    const store = memoryStore([record(), { ...record(), id: otherId, text: "Another draft" }]);
    const editor = new DraftEditor(store, id, () => otherId, () => later);
    await editor.open();
    expect(editor.getSnapshot()).toMatchObject({ text: record().text, contentLanguage: "ru", saveStatus: "saved" });
    editor.edit({ text: `${record().text}\nI can study three hours each week.`, contentLanguage: "ja" });
    expect(editor.getSnapshot().saveStatus).toBe("unsaved");
    await editor.save();
    const reopened = new DraftEditor(store, id);
    await reopened.open();
    expect(reopened.getSnapshot()).toMatchObject({ contentLanguage: "ja", savedDraft: { id, title: "My own title", updatedAt: later } });
    expect(reopened.getSnapshot().text).toContain("three hours");
    expect((await store.get(otherId))?.text).toBe("Another draft");
  });

  it("does not fall back to another record for invalid or missing links", async () => {
    const store = memoryStore([record()]);
    const invalid = new DraftEditor(store, "not-a-draft-id");
    await invalid.open();
    expect(invalid.getSnapshot().loadStatus).toBe("invalid");
    expect(store.get).not.toHaveBeenCalled();
    const missing = new DraftEditor(store, otherId);
    await missing.open();
    expect(missing.getSnapshot()).toMatchObject({ loadStatus: "missing", text: "", savedDraft: null });
    expect(store.list).not.toHaveBeenCalled();
    expect(await missing.save()).toBeNull();
  });

  it("retains unreadable records and supports reopening after a transient read failure", async () => {
    const store = memoryStore([record()]);
    vi.mocked(store.get).mockRejectedValueOnce(new StorageError("unavailable", "Blocked"));
    const editor = new DraftEditor(store, id);
    await editor.open();
    expect(editor.getSnapshot().loadStatus).toBe("error");
    expect(store.remove).not.toHaveBeenCalled();
    await editor.open();
    expect(editor.getSnapshot().loadStatus).toBe("ready");
  });

  it("rejects a storage result that belongs to a different draft", async () => {
    const store = memoryStore();
    vi.mocked(store.get).mockResolvedValue({ ...record(), id: otherId });
    const editor = new DraftEditor(store, id);
    await editor.open();
    expect(editor.getSnapshot()).toMatchObject({ loadStatus: "error", text: "", savedDraft: null, error: { code: "corrupt_record" } });
  });

  it("recovers an unsaved request across route changes without claiming or creating a saved draft", async () => {
    const store = memoryStore();
    const buffer = createRequestBuffer();
    const editor = new DraftEditor(store, null, () => id, () => time, buffer);
    editor.edit({ text: record().text, contentLanguage: "ru" });
    const returned = new DraftEditor(store, null, () => id, () => time, buffer);
    await returned.open();
    expect(returned.getSnapshot()).toMatchObject({ text: record().text, contentLanguage: "ru", saveStatus: "unsaved", savedDraft: null });
    expect(await store.list()).toEqual([]);
    await returned.save();
    expect(buffer.read("new")).toBeNull();
  });

  it("recovers an interrupted existing write only against the same stored version", async () => {
    const store = memoryStore([record()]);
    const buffer = createRequestBuffer();
    buffer.write(id, { text: "Unacknowledged edit", contentLanguage: "en", baseUpdatedAt: time });
    const editor = new DraftEditor(store, id, () => id, () => later, buffer);
    await editor.open();
    expect(editor.getSnapshot()).toMatchObject({ text: "Unacknowledged edit", saveStatus: "unsaved" });
    await store.put({ ...record(), text: "A newer saved edit", updatedAt: later });
    const reopened = new DraftEditor(store, id, () => id, () => later, buffer);
    await reopened.open();
    expect(reopened.getSnapshot()).toMatchObject({ text: "A newer saved edit", saveStatus: "saved" });
  });
});

describe("editable request helpers", () => {
  it("appends a helpful prompt while retaining the person's existing text", () => {
    expect(appendQuickAction("Learn Japanese", "My starting point: ")).toBe("Learn Japanese\n\nMy starting point: ");
    expect(appendQuickAction("", "I want to be able to ")).toBe("I want to be able to ");
  });
  it("bounds input and derives a readable first-line title", () => {
    const editor = new DraftEditor(memoryStore(), null);
    editor.edit({ text: "a".repeat(REQUEST_LIMIT + 1) });
    expect(editor.getSnapshot().text).toHaveLength(REQUEST_LIMIT);
    expect(appendQuickAction(editor.getSnapshot().text, "More")).toHaveLength(REQUEST_LIMIT);
    expect(draftTitle("\n  Understand   how models learn\nMore detail")).toBe("Understand how models learn");
    expect(draftTitle("a".repeat(200)).length).toBeLessThanOrEqual(90);
  });
});
