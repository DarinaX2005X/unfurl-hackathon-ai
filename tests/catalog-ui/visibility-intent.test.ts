import { describe, expect, it } from "vitest";
import type { ServiceResult } from "../../src/application/ports";
import type { CourseVisibilityReceipt } from "../../src/domain/progression";
import { settleVisibilityIntent, visibilityIntent, visibilityIntentIsSaved } from "../../src/features/sharing/visibility-intent";
import { ids } from "../domain/fixtures";

const input = { expectedRevision: 4, visibility: "public" as const, courseVersionId: ids.draft };
const unavailable: ServiceResult<CourseVisibilityReceipt> = { ok: false, error: { error: {
  code: "service_unavailable", messageKey: "progress.unavailable", requestId: ids.request, retryable: true,
} } };
const conflict: ServiceResult<CourseVisibilityReceipt> = { ok: false, error: { error: {
  code: "revision_conflict", messageKey: "publication.revisionConflict", requestId: ids.request, retryable: false,
}, currentRevision: 5 } };
const saved: ServiceResult<CourseVisibilityReceipt> = { ok: true, data: {
  courseId: ids.course, visibility: "public", publishedVersionId: ids.draft, revision: 5,
} };

describe("visibility mutation intent", () => {
  it("reuses the exact key and body after a transport-unknown response", () => {
    const first = visibilityIntent(null, input, () => ids.request);
    const retry = visibilityIntent(settleVisibilityIntent(first, unavailable), { ...input, expectedRevision: 5 }, () => ids.missing);
    expect(retry).toBe(first);
    expect(retry).toEqual({ key: ids.request, input });
  });

  it.each([["conflict", conflict], ["success", saved]] as const)("starts a new intent after conclusive %s", (_name, result) => {
    const first = visibilityIntent(null, input, () => ids.request);
    const next = visibilityIntent(settleVisibilityIntent(first, result), { ...input, expectedRevision: 5 }, () => ids.missing);
    expect(next.key).toBe(ids.missing);
    expect(next).not.toBe(first);
  });

  it("reconciles a lost response when the saved projection matches the retained intent", () => {
    const intent = visibilityIntent(null, input, () => ids.request);
    expect(visibilityIntentIsSaved(intent, {
      courseId: ids.course, visibility: "public", revision: 5, currentReadyVersionId: ids.draft,
      publishedVersionId: ids.draft, progress: { xpTotal: 600, level: 3, xpToNextLevel: 200,
        publication: { eligible: true, requiredLevel: 3, reasons: [] } },
    })).toBe(true);
  });
});
