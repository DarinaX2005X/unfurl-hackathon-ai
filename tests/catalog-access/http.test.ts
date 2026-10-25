import { describe, expect, it, vi } from "vitest";
import { createHttpCatalog } from "../../src/application/http-catalog";

const ids = { course: "10000000-0000-4000-8000-000000000001", version: "10000000-0000-4000-8000-000000000002",
  request: "10000000-0000-4000-8000-000000000003" };

describe("catalog HTTP adapter", () => {
  it("uses the dedicated catalog route and preserves server-side filter inputs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [], nextCursor: null } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const result = await createHttpCatalog(fetcher).listPublic({ q: "held out", contentLanguage: "en", limit: 24 });
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/catalog?q=held+out&contentLanguage=en&limit=24");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("sends enrollment only as an explicit idempotent POST", async () => {
    const enrollmentId = crypto.randomUUID();
    const payload = { enrollment: { id: enrollmentId, learnerId: crypto.randomUUID(), courseId: ids.course,
      courseVersionId: ids.version, status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null,
      createdAt: "2026-10-25T00:00:00.000Z", lastStudiedAt: null }, redirectTo: `/learn/${enrollmentId}` };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: payload }), { status: 201,
      headers: { "Content-Type": "application/json" } }));
    const result = await createHttpCatalog(fetcher).createEnrollment(ids.course, { courseVersionId: ids.version }, ids.request);
    expect(result).toEqual({ ok: true, data: payload });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(ids.request);
    expect(init?.body).toBe(JSON.stringify({ courseVersionId: ids.version }));
  });
});
