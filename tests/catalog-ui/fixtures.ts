import { vi } from "vitest";
import { localApplication } from "../../src/application/local-adapter";
import type { ApplicationPort, ServiceResult } from "../../src/application/ports";
import type { CourseSummary, Page } from "../../src/domain";
import type { DraftStore, LocalDraft } from "../../src/lib/drafts";
import { ids, timestamp } from "../domain/fixtures";

export function course(overrides: Partial<CourseSummary> = {}): CourseSummary {
  return {
    id: ids.course, slug: "model-evaluation", title: "Model evaluation", summary: "Compare evidence from training and validation data.",
    contentLanguage: "en", visibility: "public", moduleCount: 2, lessonCount: 5, estimatedStudyMinutes: 75,
    cover: { motifId: "model-capacity", alt: "Model capacity and evidence" }, ...overrides,
  };
}
export function draft(overrides: Partial<LocalDraft> = {}): LocalDraft {
  return { id: ids.draft, kind: "course_request", title: "Understand model evaluation", text: "I can program but have not studied statistics.", contentLanguage: "en", updatedAt: timestamp, schemaVersion: 1, intendedConversationId: null, ...overrides };
}
export function page(items: CourseSummary[], nextCursor: string | null = null): ServiceResult<Page<CourseSummary>> {
  return { ok: true, data: { items, nextCursor } };
}
export function failure(): ServiceResult<Page<CourseSummary>> {
  return { ok: false, error: { error: { code: "service_unavailable", messageKey: "catalog.unavailable", requestId: ids.request, retryable: true } } };
}
export function service(listPublic: ApplicationPort["listPublic"]): ApplicationPort { return { ...localApplication, listPublic }; }
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function memoryStore(initial: LocalDraft[] = []) {
  const records = new Map(initial.map((item) => [item.id, { ...item }]));
  const store = {
    list: vi.fn(async () => [...records.values()].map((item) => ({ ...item }))),
    get: vi.fn(async (id: string) => records.has(id) ? { ...records.get(id)! } : null),
    put: vi.fn(async (item: LocalDraft) => { records.set(item.id, { ...item }); }),
    remove: vi.fn(async (id: string) => { records.delete(id); }),
  } satisfies DraftStore;
  return { store, records };
}
