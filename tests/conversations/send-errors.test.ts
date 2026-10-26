import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/conversations/service", () => ({ conversationService: { sendMessage: vi.fn() } }));
vi.mock("../../src/server/runs/dispatch-after-response", () => ({ dispatchAfterResponse: vi.fn() }));
import { requireActor } from "../../src/server/auth/session";
import { ServiceFault } from "../../src/server/auth/errors";
import { ProviderFailure } from "../../src/server/ai/failure";
import { PostgresBudget } from "../../src/server/budget/postgres";
import type { DbTransaction } from "../../src/server/db";
import { conversationService } from "../../src/server/conversations/service";
import { sendMessageRoute } from "../../src/server/conversations/routes";
import { dispatchAfterResponse } from "../../src/server/runs/dispatch-after-response";
import { accepted, actor, ids, sendInput } from "./fixtures";

function request() {
  return new NextRequest(`http://127.0.0.1:3000/api/v1/conversations/${ids.conversation}/messages`, {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", "Idempotency-Key": ids.request, "X-Request-Id": ids.request },
    body: JSON.stringify(sendInput()),
  });
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(requireActor).mockResolvedValue(actor); });

describe("conversation send admission errors", () => {
  it.each([
    ["unavailable", 503, "generation.unavailable", true],
    ["timeout", 503, "generation.timeout", true],
    ["rate_limited", 429, "generation.rateLimited", true],
    ["cancelled", 503, "generation.unavailable", true],
  ] as const)("maps provider %s without dispatching an unaccepted message", async (code, status, messageKey, retryable) => {
    vi.mocked(conversationService.sendMessage).mockRejectedValueOnce(new ProviderFailure(code));
    const response = await sendMessageRoute(request(), ids.conversation);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { messageKey, retryable, requestId: ids.request } });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "campaign limit", settled: "9500000", status: 503, code: "service_unavailable", messageKey: "generation.budgetExhausted", retryable: false },
  ])("preserves the budget contract for $reason admission failures", async ({ settled, status, code, messageKey, retryable }) => {
    const tx = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("FROM unfurl.ai_budgets")
      ? [{ id: ids.source, settled_micro_usd: settled, reserved_micro_usd: "0", halted: false }]
      : [{ probe_settled: "0", probe_reserved: "0" }] })) } as unknown as DbTransaction;
    const budget = new PostgresBudget(ids.source, work => work(tx));
    vi.mocked(conversationService.sendMessage).mockImplementationOnce(async () => {
      await budget.assertAvailable({ probe: false });
      throw new Error("Expected admission rejection");
    });
    const response = await sendMessageRoute(request(), ids.conversation);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, messageKey, retryable } });
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthenticated", "auth.signInRequired", false],
    [503, "service_unavailable", "auth.unavailable", true],
  ] as const)("preserves actual authentication failure %s", async (status, code, messageKey, retryable) => {
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(status, code, messageKey, retryable));
    const response = await sendMessageRoute(request(), ids.conversation);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, messageKey, retryable } });
    expect(conversationService.sendMessage).not.toHaveBeenCalled();
    expect(dispatchAfterResponse).not.toHaveBeenCalled();
  });

  it("returns an accepted replay unchanged and dispatches only that saved run", async () => {
    const data = accepted();
    vi.mocked(conversationService.sendMessage).mockResolvedValueOnce({ status: 202, data, replayed: true });
    const response = await sendMessageRoute(request(), ids.conversation);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data });
    expect(conversationService.sendMessage).toHaveBeenCalledExactlyOnceWith(actor, sendInput(), ids.request);
    expect(dispatchAfterResponse).toHaveBeenCalledExactlyOnceWith(actor, data.run.id);
  });
});
