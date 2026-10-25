import { describe, expect, it } from "vitest";
import type { ServiceResult } from "../../src/application/ports";
import type { ShareCreated } from "../../src/domain/catalog";
import { afterShareRevoked, settleShareCreation, shareCreationIntent } from "../../src/features/sharing/share-intent";
import { ids } from "../domain/fixtures";

const input = { courseVersionId: ids.draft, expectedCourseRevision: 4 };
const unavailable: ServiceResult<ShareCreated> = { ok: false, error: { error: {
  code: "service_unavailable", messageKey: "sharing.unavailable", requestId: ids.request, retryable: true,
} } };
const conflict: ServiceResult<ShareCreated> = { ok: false, error: { error: {
  code: "revision_conflict", messageKey: "course.revisionConflict", requestId: ids.request, retryable: false,
}, currentRevision: 5 } };
const created: ServiceResult<ShareCreated> = { ok: true, data: {
  shareId: ids.course, shareUrl: `/s/${"A".repeat(43)}`, courseRevision: 5,
} };

describe("share creation intent", () => {
  it("reuses the same key and request body after a transport-unknown failure", () => {
    const first = shareCreationIntent(null, input, () => ids.request);
    const retained = settleShareCreation(first, unavailable);
    const retry = shareCreationIntent(retained, input, () => ids.missing);
    expect(retry).toBe(first);
    expect(retry.key).toBe(ids.request);
    expect(retry.input).toEqual(input);
  });

  it("starts a new intent after a conclusive conflict", () => {
    const first = shareCreationIntent(null, input, () => ids.request);
    const settled = settleShareCreation(first, conflict);
    const next = shareCreationIntent(settled, { ...input, expectedCourseRevision: 5 }, () => ids.missing);
    expect(next.key).toBe(ids.missing);
    expect(next).not.toBe(first);
  });

  it("starts a new intent after a confirmed creation", () => {
    const first = shareCreationIntent(null, input, () => ids.request);
    const settled = settleShareCreation(first, created);
    const next = shareCreationIntent(settled, { ...input, expectedCourseRevision: 5 }, () => ids.missing);
    expect(next.key).toBe(ids.missing);
  });

  it("removes the copyable link only when that exact new grant is revoked", () => {
    const created = { grantId: ids.course, url: "https://example.test/s/token" };
    expect(afterShareRevoked(created, ids.missing)).toBe(created);
    expect(afterShareRevoked(created, ids.course)).toBeNull();
  });
});
