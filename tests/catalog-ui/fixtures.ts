import { localApplication } from "../../src/application/local-adapter";
import type { ApplicationPort, ServiceResult } from "../../src/application/ports";
import type { CourseSummary, Page } from "../../src/domain";
import { ids } from "../domain/fixtures";

export function course(overrides: Partial<CourseSummary> = {}): CourseSummary {
  return {
    id: ids.course, slug: "model-evaluation", title: "Model evaluation", summary: "Compare evidence from training and validation data.",
    contentLanguage: "en", visibility: "public", moduleCount: 2, lessonCount: 5, estimatedStudyMinutes: 75,
    cover: { motifId: "model-capacity", alt: "Model capacity and evidence" }, ...overrides,
  };
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
