import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { CatalogPort } from "../../src/application/catalog-port";
import type { ServiceResult } from "../../src/application/ports";
import type { Page } from "../../src/domain";
import type { EnrolledCourseProjection, LibraryCourseItem, OwnedCourseProjection } from "../../src/domain/catalog";
import { AccountScope } from "../../src/features/account/account-scope";
import { createDraftStore } from "../../src/lib/drafts";
import { LibraryController } from "../../src/features/library/library-controller";
import { catalogService, course, deferred } from "./fixtures";
import { ids, timestamp } from "../domain/fixtures";

const enrollmentId = "00000000-0000-4000-8000-000000000097";
const owned: OwnedCourseProjection = {
  id: ids.course, slug: "model-evaluation", title: "Model evaluation", summary: "Compare evidence from training and validation data.",
  contentLanguage: "en", visibility: "public", currentReadyVersionId: ids.draft, publishedVersionId: ids.draft,
  updatedAt: timestamp, revision: 2, cover: { motifId: "model-capacity", alt: "Model capacity and evidence" },
  latestVersion: { id: ids.draft, number: 1, state: "ready" }, conversationId: null,
};
const enrolledCourse = course({ id: ids.missing, slug: "reading-japanese", title: "Reading Japanese", summary: "Read short stories with confidence.", contentLanguage: "ja" });
const enrolled: EnrolledCourseProjection = {
  course: enrolledCourse, version: { id: ids.source, number: 2 },
  enrollment: { id: enrollmentId, learnerId: ids.actor, courseId: enrolledCourse.id, courseVersionId: ids.source, status: "active", routeRevision: 1,
    currentLessonId: null, currentTaskId: null, createdAt: timestamp, lastStudiedAt: timestamp },
};
const ownedGroup: LibraryCourseItem = { courseId: owned.id, owned, enrollments: [] };
const enrolledGroup: LibraryCourseItem = { courseId: enrolledCourse.id, owned: null, enrollments: [enrolled] };
const page = (items: LibraryCourseItem[], nextCursor: string | null = null): ServiceResult<Page<LibraryCourseItem>> => ({ ok: true, data: { items, nextCursor } });
const failure = (): ServiceResult<Page<LibraryCourseItem>> => ({ ok: false, error: { error: { code: "service_unavailable", messageKey: "library.unavailable", requestId: ids.request, retryable: true } } });
function controller(listLibrary: CatalogPort["listLibrary"]) {
  const scope = new AccountScope();
  scope.replaceActor(ids.actor);
  return new LibraryController(catalogService({ listLibrary }), ids.actor, scope);
}

describe("grouped course library boundary", () => {
  it("renders an authoritative empty library and sends the selected server filters", async () => {
    const listLibrary = vi.fn<CatalogPort["listLibrary"]>().mockResolvedValue(page([]));
    const subject = controller(listLibrary);
    await subject.search({ q: "evidence", contentLanguage: "en", view: "courses" });
    expect(subject.getSnapshot()).toMatchObject({ status: "ready", items: [], nextCursor: null, refreshing: false });
    expect(listLibrary.mock.calls[0]![0]).toEqual({ q: "evidence", contentLanguage: "en", view: "courses", limit: 24 });
  });

  it("never turns a saved legacy conversation into a course or deletes its data", async () => {
    const store = createDraftStore({ indexedDB: new IDBFactory(), databaseName: "legacy-library-isolation" });
    const saved = { id: ids.draft, kind: "course_request" as const, title: "Learn astronomy", text: "I want to understand the night sky", contentLanguage: "en", updatedAt: timestamp, schemaVersion: 1 as const, intendedConversationId: null };
    const subject = controller(async () => page([]));
    await store.put(saved);
    await subject.search({});
    expect(subject.getSnapshot().items).toEqual([]);
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it("rejects a chat-shaped result at the service boundary instead of rendering it as a course", async () => {
    const invalid = { kind: "conversation", id: ids.draft, title: "A chat is not a course", text: "Explain gravity" };
    const subject = controller(async () => page([invalid as unknown as LibraryCourseItem]));
    await subject.search({});
    expect(subject.getSnapshot()).toMatchObject({ status: "error", items: [] });
  });

  it("uses only grouped authoritative courses and retains them if a refresh fails", async () => {
    const listLibrary = vi.fn<CatalogPort["listLibrary"]>().mockResolvedValueOnce(page([ownedGroup, enrolledGroup])).mockResolvedValueOnce(failure()).mockResolvedValueOnce(page([enrolledGroup]));
    const subject = controller(listLibrary);
    await subject.search({});
    expect(subject.getSnapshot().items).toEqual([ownedGroup, enrolledGroup]);
    await subject.refresh();
    expect(subject.getSnapshot()).toMatchObject({ status: "error", items: [ownedGroup, enrolledGroup], refreshing: false });
    await subject.refresh();
    expect(subject.getSnapshot()).toMatchObject({ status: "ready", items: [enrolledGroup] });
  });

  it("aborts an older load and ignores its late response", async () => {
    const old = deferred<ServiceResult<Page<LibraryCourseItem>>>();
    const signals: AbortSignal[] = [];
    const listLibrary = vi.fn<CatalogPort["listLibrary"]>().mockImplementationOnce((_query, signal) => { signals.push(signal!); return old.promise; }).mockResolvedValueOnce(page([enrolledGroup]));
    const subject = controller(listLibrary);
    const first = subject.search({ q: "old" });
    await Promise.resolve();
    await subject.search({ q: "new" });
    expect(signals[0]?.aborted).toBe(true);
    old.resolve(page([ownedGroup]));
    await first;
    expect(subject.getSnapshot().items).toEqual([enrolledGroup]);
  });

  it("keeps loaded groups when pagination fails and retries the same cursor", async () => {
    const listLibrary = vi.fn<CatalogPort["listLibrary"]>().mockResolvedValueOnce(page([ownedGroup], "next")).mockResolvedValueOnce(failure()).mockResolvedValueOnce(page([enrolledGroup]));
    const subject = controller(listLibrary);
    await subject.search({ view: "all" });
    await subject.loadMore();
    expect(subject.getSnapshot()).toMatchObject({ items: [ownedGroup], nextCursor: "next", loadingMore: false });
    expect(subject.getSnapshot().pageError).toBeTruthy();
    await subject.loadMore();
    expect(listLibrary.mock.calls[1]![0]).toEqual({ view: "all", limit: 24, cursor: "next" });
    expect(listLibrary.mock.calls[2]![0]).toEqual(listLibrary.mock.calls[1]![0]);
    expect(subject.getSnapshot()).toMatchObject({ items: [ownedGroup, enrolledGroup], nextCursor: null, pageError: null });
  });
});
