import { describe, expect, it, vi } from "vitest";
import { createHttpProgression } from "../../src/application/http-progression";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const courseId = id("1");
const versionId = id("2");
const key = id("3");
const progress = {
  xpTotal: 500,
  level: 3,
  xpToNextLevel: 250,
  publication: { eligible: true, requiredLevel: 3, reasons: [] },
};

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("progression HTTP port", () => {
  it("reads account and owner visibility projections with no-store same-origin requests", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: progress }))
      .mockResolvedValueOnce(response({ data: {
        courseId,
        visibility: "private",
        currentReadyVersionId: versionId,
        publishedVersionId: null,
        revision: 4,
        progress,
      } }));
    const port = createHttpProgression(fetcher);
    expect(await port.getAccountProgress()).toEqual({ ok: true, data: progress });
    expect(await port.getCourseVisibility(courseId)).toMatchObject({ ok: true, data: { courseId, revision: 4 } });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/me/progress");
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/v1/courses/${courseId}/visibility`);
    expect(fetcher.mock.calls.every((call) => call[1]?.cache === "no-store" && call[1]?.credentials === "same-origin")).toBe(true);
  });

  it("sends the exact visibility body with the caller's stable idempotency key", async () => {
    const receipt = { courseId, visibility: "public", publishedVersionId: versionId, revision: 5 } as const;
    const fetcher = vi.fn(async () => response({ data: receipt }));
    const port = createHttpProgression(fetcher);
    const input = { expectedRevision: 4, visibility: "public", courseVersionId: versionId } as const;
    expect(await port.setVisibility(courseId, input, { idempotencyKey: key })).toEqual({ ok: true, data: receipt });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/courses/${courseId}/visibility`, expect.objectContaining({
      method: "PATCH",
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify(input),
      headers: expect.objectContaining({ "Idempotency-Key": key, "Content-Type": "application/json" }),
    }));
  });

  it("rejects invalid authority fields and identities before fetch", async () => {
    const fetcher = vi.fn();
    const port = createHttpProgression(fetcher);
    const result = await port.setVisibility(courseId, {
      expectedRevision: 4, visibility: "public", courseVersionId: versionId, level: 9,
    } as never, { idempotencyKey: key });
    expect(result).toMatchObject({ ok: false, error: { error: { code: "invalid_input" } } });
    expect(await port.getCourseVisibility("not-an-id")).toMatchObject({ ok: false, error: { error: { code: "invalid_input" } } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves typed 409 revisions and aborts without converting cancellation to service failure", async () => {
    const conflict = { error: { code: "revision_conflict", messageKey: "publication.revisionConflict", retryable: false, requestId: id("8") }, currentRevision: 7 };
    const fetcher = vi.fn(async () => response(conflict, 409));
    const port = createHttpProgression(fetcher);
    expect(await port.setVisibility(courseId, {
      expectedRevision: 4, visibility: "public", courseVersionId: versionId,
    }, { idempotencyKey: key })).toEqual({ ok: false, error: conflict });

    const controller = new AbortController();
    controller.abort();
    await expect(port.getAccountProgress(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
