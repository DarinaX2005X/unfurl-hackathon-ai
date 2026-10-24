import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { localApplication } from "../../src/application/local-adapter";
import type { ApplicationPort, LibraryItem, ServiceResult } from "../../src/application/ports";
import type { Page } from "../../src/domain";
import { createDraftStore } from "../../src/lib/drafts";
import { LibraryController, selectLibraryItems } from "../../src/features/library/library-controller";
import { course, deferred } from "./fixtures";
import { ids, timestamp } from "../domain/fixtures";

const owned: LibraryItem = { kind: "owned", course: course() };
const enrolled: LibraryItem = { kind: "enrolled", course: course({ id: "00000000-0000-4000-8000-000000000099", title: "Reading Japanese", summary: "Read short stories with confidence.", contentLanguage: "ja" }), enrollmentId: "00000000-0000-4000-8000-000000000097", lastStudiedAt: timestamp };
const newEnrollment: LibraryItem = { ...enrolled, enrollmentId: "00000000-0000-4000-8000-000000000098", lastStudiedAt: null };
const page = (items: LibraryItem[]): ServiceResult<Page<LibraryItem>> => ({ ok: true, data: { items, nextCursor: null } });
const failure = (): ServiceResult<Page<LibraryItem>> => ({ ok: false, error: { error: { code: "service_unavailable", messageKey: "library.unavailable", requestId: ids.request, retryable: true } } });
function service(listLibrary: ApplicationPort["listLibrary"]): ApplicationPort {
  return { ...localApplication, capabilities: async () => ({ generation: false, cloudIdentity: true, cloudPersistence: true }), listLibrary };
}

describe("course-only library boundary", () => {
  it("distinguishes unavailable capability from an empty library and does not fetch a fictional account", async () => {
    const listLibrary = vi.fn(async () => page([]));
    const unavailable = new LibraryController({ ...localApplication, listLibrary });
    await unavailable.refresh();
    expect(unavailable.getSnapshot()).toMatchObject({ status: "unavailable", items: [], refreshing: false });
    expect(listLibrary).not.toHaveBeenCalled();
    const empty = new LibraryController(service(listLibrary));
    await empty.refresh();
    expect(empty.getSnapshot()).toMatchObject({ status: "ready", items: [] });
  });

  it("never turns a saved legacy conversation into a course or deletes its data during visits or reload", async () => {
    const store = createDraftStore({ indexedDB: new IDBFactory(), databaseName: "legacy-library-isolation" });
    const saved = { id: ids.draft, kind: "course_request" as const, title: "Learn astronomy", text: "I want to understand the night sky", contentLanguage: "en", updatedAt: timestamp, schemaVersion: 1 as const, intendedConversationId: null };
    const controller = new LibraryController(service(async () => page([])));
    await controller.refresh();
    expect(controller.getSnapshot().items).toEqual([]);
    await store.put(saved);
    await controller.refresh();
    expect(controller.getSnapshot().items).toEqual([]);
    await store.put({ ...saved, text: `${saved.text}. Start with constellations.` });
    const reloaded = new LibraryController(service(async () => page([])));
    await reloaded.refresh();
    expect(reloaded.getSnapshot().items).toEqual([]);
    expect(await store.get(saved.id)).toEqual({ ...saved, text: `${saved.text}. Start with constellations.` });
  });

  it("rejects a chat-shaped result at the service boundary instead of rendering it as a course", async () => {
    const invalid = { kind: "conversation", id: ids.draft, title: "A chat is not a course", text: "Explain gravity" };
    const controller = new LibraryController(service(async () => page([invalid as unknown as LibraryItem])));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "error", items: [] });
  });

  it("uses only authoritative courses and retains them if a refresh fails", async () => {
    const listLibrary = vi.fn<ApplicationPort["listLibrary"]>().mockResolvedValueOnce(page([owned, enrolled])).mockResolvedValueOnce(failure()).mockResolvedValueOnce(page([enrolled]));
    const controller = new LibraryController(service(listLibrary));
    await controller.refresh();
    expect(controller.getSnapshot().items).toEqual([owned, enrolled]);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "error", items: [owned, enrolled], refreshing: false });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", items: [enrolled] });
  });

  it("aborts an older load and ignores its late response", async () => {
    const old = deferred<ServiceResult<Page<LibraryItem>>>();
    const signals: AbortSignal[] = [];
    const listLibrary = vi.fn<ApplicationPort["listLibrary"]>().mockImplementationOnce((signal) => { signals.push(signal!); return old.promise; }).mockResolvedValueOnce(page([enrolled]));
    const controller = new LibraryController(service(listLibrary));
    const first = controller.refresh();
    await Promise.resolve();
    await controller.refresh();
    expect(signals[0]?.aborted).toBe(true);
    old.resolve(page([owned]));
    await first;
    expect(controller.getSnapshot().items).toEqual([enrolled]);
  });

  it("does not accept a capability response after unmount", async () => {
    const capabilities = deferred<Awaited<ReturnType<ApplicationPort["capabilities"]>>>();
    const listLibrary = vi.fn(async () => page([owned]));
    const controller = new LibraryController({ ...service(listLibrary), capabilities: () => capabilities.promise });
    const pending = controller.refresh();
    controller.dispose();
    capabilities.resolve({ generation: false, cloudIdentity: true, cloudPersistence: true });
    await pending;
    expect(listLibrary).not.toHaveBeenCalled();
    expect(controller.getSnapshot().items).toEqual([]);
  });
});

describe("course library views", () => {
  const items = [owned, enrolled, newEnrollment];
  it("keeps created courses separate from actual started enrollments", () => {
    expect(selectLibraryItems(items, {}, "courses")).toEqual([owned]);
    expect(selectLibraryItems(items, {}, "in_progress")).toEqual([enrolled]);
    expect(selectLibraryItems(items, {}, "all")).toEqual(items);
  });
  it("searches title and summary and filters course language without changing the records", () => {
    expect(selectLibraryItems(items, { q: "confidence", contentLanguage: "ja" }, "all")).toEqual([enrolled, newEnrollment]);
    expect(selectLibraryItems(items, { q: "evaluation", contentLanguage: "ja" }, "all")).toEqual([]);
    expect(selectLibraryItems(items, {}, "all")).toEqual(items);
  });
});
