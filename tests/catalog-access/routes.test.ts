import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/auth/session", () => ({ getActor: vi.fn(), requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/catalog/service", () => ({ catalogService: { listPublic: vi.fn(), getBySlug: vi.fn(), getCourse: vi.fn() } }));
vi.mock("../../src/server/sharing/service", () => ({ sharingService: { list: vi.fn(), resolve: vi.fn(), create: vi.fn(), revoke: vi.fn() } }));
vi.mock("../../src/server/enrollments/service", () => ({ enrollmentService: { enroll: vi.fn() } }));
import { getActor, requireActor } from "../../src/server/auth/session";
import { catalogService } from "../../src/server/catalog/service";
import { sharingService } from "../../src/server/sharing/service";
import { enrollmentService } from "../../src/server/enrollments/service";
import { listCatalogRoute } from "../../src/server/catalog/routes";
import { createShareRoute, resolveShareRoute } from "../../src/server/sharing/routes";
import { createEnrollmentRoute } from "../../src/server/enrollments/routes";
import { ServiceFault } from "../../src/server/auth/errors";

const ids = { actor: "10000000-0000-4000-8000-000000000001", session: "10000000-0000-4000-8000-000000000002",
  course: "10000000-0000-4000-8000-000000000003", version: "10000000-0000-4000-8000-000000000004",
  request: "10000000-0000-4000-8000-000000000005" };
const actor = { id: ids.actor, sessionId: ids.session, email: null };
function request(path: string, method = "GET", body?: unknown, origin = "http://127.0.0.1:3000") {
  return new NextRequest(`http://127.0.0.1:3000${path}`, { method, headers: { Origin: origin,
    ...(method === "GET" ? {} : { "Content-Type": "application/json", "Idempotency-Key": ids.request }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActor).mockResolvedValue(null);
  vi.mocked(requireActor).mockResolvedValue(actor);
});

describe("catalog API boundaries", () => {
  it("rejects duplicated query fields and applies the catalog default in the service", async () => {
    expect((await listCatalogRoute(request("/api/v1/catalog?q=a&q=b"))).status).toBe(400);
    expect(catalogService.listPublic).not.toHaveBeenCalled();
    vi.mocked(catalogService.listPublic).mockResolvedValueOnce({ items: [], nextCursor: null });
    const response = await listCatalogRoute(request("/api/v1/catalog?contentLanguage=en"));
    expect(response.status).toBe(200);
    expect(catalogService.listPublic).toHaveBeenCalledWith({ contentLanguage: "en" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects cross-origin and unauthenticated share writes before mutation", async () => {
    const input = { courseVersionId: ids.version, expectedCourseRevision: 2 };
    expect((await createShareRoute(request(`/api/v1/courses/${ids.course}/shares`, "POST", input, "https://other.example"), ids.course)).status).toBe(403);
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(401, "unauthenticated", "auth.signInRequired"));
    expect((await createShareRoute(request(`/api/v1/courses/${ids.course}/shares`, "POST", input), ids.course)).status).toBe(401);
    expect(sharingService.create).not.toHaveBeenCalled();
  });

  it("keeps revoked/unknown share failures uniform and uncached", async () => {
    vi.mocked(sharingService.resolve).mockRejectedValueOnce(new ServiceFault(404, "not_found", "catalog.notFound"));
    const response = await resolveShareRoute(request("/api/v1/shares/hidden-token"), "hidden-token");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).not.toHaveProperty("data");
  });

  it("requires a mounted enrollment POST with a valid idempotency identity", async () => {
    const input = { courseVersionId: ids.version };
    vi.mocked(enrollmentService.enroll).mockResolvedValueOnce({ status: 201, replayed: false, data: {
      enrollment: { id: crypto.randomUUID(), learnerId: ids.actor, courseId: ids.course, courseVersionId: ids.version,
        status: "active", routeRevision: 1, currentLessonId: null, currentTaskId: null,
        createdAt: "2026-10-25T00:00:00.000Z", lastStudiedAt: null }, redirectTo: `/learn/${crypto.randomUUID()}`,
    } });
    const bad = request(`/api/v1/courses/${ids.course}/enrollments`, "POST", input);
    bad.headers.delete("Idempotency-Key");
    expect((await createEnrollmentRoute(bad, ids.course)).status).toBe(400);
    expect(enrollmentService.enroll).not.toHaveBeenCalled();
  });
});
