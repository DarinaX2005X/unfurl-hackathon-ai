import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("@/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("@/server/learning/service", () => ({ learningService: { loadSession: vi.fn(), getActivity: vi.fn(), startActivity: vi.fn(), saveInput: vi.fn(), dispatchAction: vi.fn(), retryAction: vi.fn(), advance: vi.fn(), revisit: vi.fn() } }));
import { requireActor } from "@/server/auth/session";
import { learningService } from "@/server/learning/service";
import { loadSessionRoute, startActivityRoute, saveInputRoute, revisitRoute } from "@/server/learning/routes";
import { ServiceFault } from "@/server/auth/errors";

const actor = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), email: null }, id = crypto.randomUUID(), key = crypto.randomUUID();
const request = (body?: unknown, origin = "http://127.0.0.1:3000") => new NextRequest(`http://127.0.0.1:3000/api/v1/enrollments/${id}/activity-sessions`, {
  method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireActor).mockResolvedValue(actor); });
describe("learning API authority boundary", () => {
  it("rejects cross-origin and unauthenticated writes before service execution", async () => {
    const body = { taskId: id, taskVersion: 1 };
    expect((await startActivityRoute(request(body, "https://other.example"), id)).status).toBe(403);
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(401, "unauthenticated", "auth.signInRequired"));
    expect((await startActivityRoute(request(body), id)).status).toBe(401);
    expect(learningService.startActivity).not.toHaveBeenCalled();
  });
  it("rejects authority fields and invalid saved responses with useful pointers", async () => {
    const reply = await saveInputRoute(request({ expectedInputRevision: -1, response: {}, assistance: "independent" }), id);
    expect(reply.status).toBe(400);
    expect((await reply.json()).error.fieldErrors["/expectedInputRevision"]).toEqual(expect.any(String));
    expect(learningService.saveInput).not.toHaveBeenCalled();
    expect((await saveInputRoute(request({ expectedInputRevision: 0, response: { text: "界".repeat(131_072) } }), id)).status).toBe(400);
  });
  it("uses a fresh actor on each GET and never calls a write to initialize the session", async () => {
    vi.mocked(learningService.loadSession).mockRejectedValue(new ServiceFault(404, "not_found", "learning.notFound"));
    const response = await loadSessionRoute(request(), id);
    await loadSessionRoute(request(), id);
    expect(requireActor).toHaveBeenCalledTimes(2);
    expect(learningService.loadSession).toHaveBeenCalledWith(actor, id);
    expect(learningService.startActivity).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("revisit forwards only the explicit CAS position and stable command key", async () => {
    const body = { expectedRouteRevision: 3, lessonId: crypto.randomUUID(), taskId: null };
    vi.mocked(learningService.revisit).mockRejectedValue(new ServiceFault(403, "forbidden", "learning.revisitNotAvailable"));
    expect((await revisitRoute(request(body), id)).status).toBe(403);
    expect(learningService.revisit).toHaveBeenCalledWith(actor, id, { key, body });
  });
});
