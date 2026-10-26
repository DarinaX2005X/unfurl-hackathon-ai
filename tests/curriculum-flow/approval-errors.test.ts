import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/curricula/service", () => ({ curriculumService: { approve: vi.fn() } }));
vi.mock("../../src/server/runs/dispatch-after-response", () => ({ dispatchAfterResponse: vi.fn() }));
import { requireActor } from "../../src/server/auth/session";
import { ServiceFault } from "../../src/server/auth/errors";
import { ProviderFailure } from "../../src/server/ai/failure";
import { curriculumService } from "../../src/server/curricula/service";
import { approveCurriculumRoute } from "../../src/server/curricula/routes";
import { dispatchAfterResponse } from "../../src/server/runs/dispatch-after-response";
import { actor, ids } from "../conversations/fixtures";
function request() {
  return new NextRequest(`http://127.0.0.1:3000/api/v1/curricula/${ids.source}/approve`, { method: "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", "Idempotency-Key": ids.request },
    body: JSON.stringify({ expectedRevision: 2, contentDigest: "a".repeat(64) }) });
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(requireActor).mockResolvedValue(actor); });
describe("approval failure boundary", () => {
  it.each([
    ["rate_limited", 429, "generation.rateLimited", true],
    ["budget_exhausted", 503, "generation.budgetExhausted", false],
    ["unavailable", 503, "generation.unavailable", true],
    ["cancelled", 503, "generation.unavailable", true],
  ] as const)("preserves actionable %s admission errors without dispatch", async (code, status, messageKey, retryable) => {
    vi.mocked(curriculumService.approve).mockRejectedValueOnce(new ProviderFailure(code));
    const response = await approveCurriculumRoute(request(), ids.source);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { messageKey, retryable } });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });
  it("preserves an authenticated approval revision conflict", async () => {
    vi.mocked(curriculumService.approve).mockRejectedValueOnce(new ServiceFault(409, "revision_conflict", "curriculum.changed", false, { currentRevision: 3 }));
    const response = await approveCurriculumRoute(request(), ids.source);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { messageKey: "curriculum.changed" }, currentRevision: 3 });
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });
  it("preserves authentication failures before admission", async () => {
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(401, "unauthenticated", "auth.signInRequired"));
    const response = await approveCurriculumRoute(request(), ids.source);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { messageKey: "auth.signInRequired" } });
    expect(curriculumService.approve).not.toHaveBeenCalled();
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });
});
