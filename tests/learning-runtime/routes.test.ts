import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("@/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("@/server/learning/service", () => ({ learningService: { loadSession: vi.fn(), loadContext: vi.fn(), getActivity: vi.fn(), startActivity: vi.fn(), saveInput: vi.fn(), dispatchAction: vi.fn(), retryAction: vi.fn(), advance: vi.fn(), revisit: vi.fn(), requestFreshAssessment: vi.fn(), submitAttempt: vi.fn(), requestHint: vi.fn(), revealAnswer: vi.fn(), getEvaluation: vi.fn(), acknowledgeFeedback: vi.fn() } }));
import { requireActor } from "@/server/auth/session";
import { learningService } from "@/server/learning/service";
import { loadSessionRoute, loadContextRoute, getEvaluationRoute, requestHintRoute, submitAttemptRoute, acknowledgeFeedbackRoute, startActivityRoute, saveInputRoute, revisitRoute, requestFreshAssessmentRoute } from "@/server/learning/routes";
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
  it("bounds context pagination and rejects injected query fields", async () => {
    vi.mocked(learningService.loadContext).mockRejectedValue(new ServiceFault(404, "not_found", "learning.notFound"));
    const page = (query: string) => new NextRequest(`http://127.0.0.1:3000/api/v1/enrollments/${id}/context?${query}`);
    expect((await loadContextRoute(page("limit=20&cursor=opaque"), id)).status).toBe(404);
    expect(learningService.loadContext).toHaveBeenCalledWith(actor, id, { limit: 20, cursor: "opaque" });
    vi.mocked(learningService.loadContext).mockClear();
    for (const query of ["limit=101", "limit=", "limit=2.5", "learnerId=other", "cursor="]) expect((await loadContextRoute(page(query), id)).status).toBe(400);
    expect(learningService.loadContext).not.toHaveBeenCalled();
  });
  it("fresh assessment accepts only explicit route CAS, never client-chosen task or independence", async () => {
    const body = { expectedRouteRevision: 3 };
    expect((await requestFreshAssessmentRoute(request({ ...body, taskId: key, independent: true }), id)).status).toBe(400);
    expect(learningService.requestFreshAssessment).not.toHaveBeenCalled();
    vi.mocked(learningService.requestFreshAssessment).mockRejectedValue(new ServiceFault(409, "revision_conflict", "learning.freshAssessment.noUnseenAssessment"));
    expect((await requestFreshAssessmentRoute(request(body), id)).status).toBe(409);
    expect(learningService.requestFreshAssessment).toHaveBeenCalledWith(actor, id, { key, body });
  });
  it("evaluation GET does not acknowledge feedback; assistance and submissions reject authority fields", async () => {
    vi.mocked(learningService.getEvaluation).mockRejectedValue(new ServiceFault(404, "not_found", "learning.notFound"));
    expect((await getEvaluationRoute(request(), id)).status).toBe(404);
    expect(learningService.acknowledgeFeedback).not.toHaveBeenCalled();
    expect((await requestHintRoute(request({ taskId: id, taskVersion: 1, hintIndex: 0, content: "injected" }), id)).status).toBe(400);
    expect((await submitAttemptRoute(request({ taskId: id, awardedXp: 25 }), id)).status).toBe(400);
    expect(learningService.requestHint).not.toHaveBeenCalled();
    expect(learningService.submitAttempt).not.toHaveBeenCalled();
    vi.mocked(learningService.acknowledgeFeedback).mockRejectedValue(new ServiceFault(409, "revision_conflict", "learning.evaluationChanged"));
    expect((await acknowledgeFeedbackRoute(request({ expectedEvaluationRevision: 2 }), id)).status).toBe(409);
    expect(learningService.acknowledgeFeedback).toHaveBeenCalledWith(actor, id, { key, body: { expectedEvaluationRevision: 2 } });
  });
});
