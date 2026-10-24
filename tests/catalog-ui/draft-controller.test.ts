import { describe, expect, it, vi } from "vitest";
import { StorageError, type LocalDraft } from "../../src/lib/drafts";
import { DraftController } from "../../src/features/library/draft-controller";
import { ids } from "../domain/fixtures";
import { deferred, draft, memoryStore } from "./fixtures";

describe("local library draft operations", () => {
  it("does not create records while constructing or reading an empty library", async () => {
    const { store, records } = memoryStore();
    const controller = new DraftController(store);
    expect(store.put).not.toHaveBeenCalled();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", drafts: [] });
    expect(store.put).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it("renames the same ID while preserving content freshly saved in another view", async () => {
    const original = draft();
    const neighbor = draft({ id: ids.missing, title: "A second request" });
    const { store, records } = memoryStore([original, neighbor]);
    const controller = new DraftController(store);
    await controller.refresh();
    const fresh = { ...original, text: "New text saved after the library was opened", contentLanguage: "ja", intendedConversationId: ids.conversation };
    records.set(original.id, fresh);
    expect(await controller.rename(original.id, "  Evaluation from evidence  ")).toBe(true);
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.put.mock.calls[0]![0]).toMatchObject({ ...fresh, title: "Evaluation from evidence", updatedAt: expect.any(String) });
    expect(Date.parse(store.put.mock.calls[0]![0].updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));
    expect(records.size).toBe(2);
    expect(records.get(neighbor.id)).toEqual(neighbor);
    expect(controller.getSnapshot().drafts.find((item) => item.id === original.id)?.text).toBe(fresh.text);
  });

  it("does not resurrect a missing draft during rename", async () => {
    const original = draft();
    const { store, records } = memoryStore([original]);
    const controller = new DraftController(store);
    await controller.refresh();
    records.delete(original.id);
    expect(await controller.rename(original.id, "New title")).toBe(false);
    expect(store.put).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
    expect(controller.getSnapshot().actionError).toContain("no longer");
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it.each(["corrupt_record", "version_unsupported", "unavailable"] as const)("keeps records when reading fails with %s and recovers on retry", async (code) => {
    const original = draft();
    const { store, records } = memoryStore([original]);
    const controller = new DraftController(store);
    await controller.refresh();
    store.list.mockRejectedValueOnce(new StorageError(code, "Read failed", { draftId: original.id }));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "error", drafts: [original] });
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(records.get(original.id)).toEqual(original);
    expect(store.remove).not.toHaveBeenCalled();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", drafts: [original], error: null });
  });

  it("preserves the original title and neighbors when a rename cannot be persisted", async () => {
    const original = draft();
    const neighbor = draft({ id: ids.missing });
    const { store, records } = memoryStore([original, neighbor]);
    const controller = new DraftController(store);
    await controller.refresh();
    store.put.mockRejectedValueOnce(new StorageError("quota_exceeded", "No space"));
    expect(await controller.rename(original.id, "Changed title")).toBe(false);
    expect(controller.getSnapshot().drafts).toEqual([original, neighbor]);
    expect(records.get(original.id)).toEqual(original);
    expect(records.get(neighbor.id)).toEqual(neighbor);
    expect(controller.getSnapshot().actionError).toContain("no room");
  });

  it("deletes only the selected record after persistence succeeds", async () => {
    const original = draft();
    const neighbor = draft({ id: ids.missing, title: "Keep this draft" });
    const { store, records } = memoryStore([original, neighbor]);
    const controller = new DraftController(store);
    await controller.refresh();
    expect(await controller.remove(original.id)).toBe(true);
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(original.id);
    expect([...records.values()]).toEqual([neighbor]);
    expect(controller.getSnapshot().drafts).toEqual([neighbor]);
  });

  it("keeps a selected draft visible when deletion fails", async () => {
    const original = draft();
    const { store, records } = memoryStore([original]);
    const controller = new DraftController(store);
    await controller.refresh();
    store.remove.mockRejectedValueOnce(new StorageError("unavailable", "Storage closed"));
    expect(await controller.remove(original.id)).toBe(false);
    expect(controller.getSnapshot().drafts).toEqual([original]);
    expect(records.has(original.id)).toBe(true);
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("creates a real local draft only after an explicit action and acknowledges its persisted ID", async () => {
    const write = deferred<void>();
    const { store } = memoryStore();
    store.put.mockImplementationOnce(() => write.promise);
    const controller = new DraftController(store);
    const action = controller.create("  Learn model evaluation  ");
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ drafts: [], pending: "new" });
    expect(await controller.create("Duplicate press")).toBeNull();
    expect(store.put).toHaveBeenCalledTimes(1);
    write.resolve();
    const id = await action;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(controller.getSnapshot().drafts).toEqual([expect.objectContaining({ id, title: "Learn model evaluation", text: "", kind: "course_request", contentLanguage: "en", intendedConversationId: null })]);
  });

  it("does not claim a created draft when persistence rejects", async () => {
    const { store } = memoryStore();
    store.put.mockRejectedValueOnce(new StorageError("quota_exceeded", "No space"));
    const controller = new DraftController(store);
    expect(await controller.create("Learn evaluation")).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ drafts: [], pending: null });
    expect(controller.getSnapshot().actionError).toContain("no room");
  });

  it("ignores an older refresh that finishes after the latest refresh", async () => {
    const old = deferred<LocalDraft[]>();
    const latest = deferred<LocalDraft[]>();
    const { store } = memoryStore();
    store.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const controller = new DraftController(store);
    const oldLoad = controller.refresh();
    const latestLoad = controller.refresh();
    const current = draft({ title: "Latest saved draft" });
    latest.resolve([current]);
    await latestLoad;
    old.resolve([draft({ title: "Stale draft" })]);
    await oldLoad;
    expect(controller.getSnapshot().drafts).toEqual([current]);
  });

  it("keeps a successful rename if a refresh started earlier returns stale records", async () => {
    const original = draft();
    const { store } = memoryStore([original]);
    const controller = new DraftController(store);
    await controller.refresh();
    const staleRead = deferred<LocalDraft[]>();
    store.list.mockReturnValueOnce(staleRead.promise);
    const refreshing = controller.refresh();
    await controller.rename(original.id, "Newly saved title");
    staleRead.resolve([original]);
    await refreshing;
    expect(controller.getSnapshot().drafts.find((item) => item.id === original.id)?.title).toBe("Newly saved title");
  });

  it("does not restore a deleted draft when an earlier refresh returns", async () => {
    const original = draft();
    const neighbor = draft({ id: ids.missing, title: "Keep this draft" });
    const { store } = memoryStore([original, neighbor]);
    const controller = new DraftController(store);
    await controller.refresh();
    const staleRead = deferred<LocalDraft[]>();
    store.list.mockReturnValueOnce(staleRead.promise);
    const refreshing = controller.refresh();
    await controller.remove(original.id);
    staleRead.resolve([original, neighbor]);
    await refreshing;
    expect(controller.getSnapshot().drafts).toEqual([neighbor]);
  });

  it("keeps an acknowledged new draft when an earlier empty refresh returns", async () => {
    const { store } = memoryStore();
    const controller = new DraftController(store);
    const staleRead = deferred<LocalDraft[]>();
    store.list.mockReturnValueOnce(staleRead.promise);
    const refreshing = controller.refresh();
    const id = await controller.create("New request");
    staleRead.resolve([]);
    await refreshing;
    expect(controller.getSnapshot().drafts).toEqual([expect.objectContaining({ id, title: "New request" })]);
    expect(controller.getSnapshot().status).toBe("ready");
  });

  it("notifies subscribers with current state and allows clean unsubscription", async () => {
    const { store } = memoryStore();
    const controller = new DraftController(store);
    const listener = vi.fn(() => controller.getSnapshot().status);
    const unsubscribe = controller.subscribe(listener);
    await controller.refresh();
    expect(listener.mock.results.map((result) => result.value)).toEqual(["loading", "ready"]);
    unsubscribe();
    await controller.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
