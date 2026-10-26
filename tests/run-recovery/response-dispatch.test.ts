import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ after: vi.fn(), dispatch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("../../src/server/runs/dispatcher", () => ({ dispatchOwnedExecution: mocks.dispatch }));
vi.mock("../../src/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/conversations/service", () => ({ conversationService: { get: vi.fn(), sendMessage: vi.fn() } }));
import { NextRequest } from "next/server";
import { requireActor } from "../../src/server/auth/session";
import { conversationService } from "../../src/server/conversations/service";
import { getConversationRoute, sendMessageRoute } from "../../src/server/conversations/routes";
import { ServiceFault } from "../../src/server/auth/errors";
import { accepted, actor, detail, ids, sendInput } from "../conversations/fixtures";

const callbacks: Array<() => Promise<void>> = [];
const delivery = { scanned: 0, dispatched: 0, failed: 0, recovered: 0, reconciled: 0 };
function request(body?: unknown) {
  return new NextRequest(`http://127.0.0.1:3000/api/v1/conversations/${ids.conversation}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", "Idempotency-Key": ids.request },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); callbacks.length = 0;
  mocks.after.mockImplementation((callback) => { callbacks.push(callback); });
  mocks.dispatch.mockResolvedValue(delivery);
  vi.mocked(requireActor).mockResolvedValue(actor);
});

describe("response latency and durable dispatch boundary", () => {
  it("returns the authorized chat before running its recovery scan", async () => {
    vi.mocked(conversationService.get).mockResolvedValue(detail());
    const response = await getConversationRoute(request(), ids.conversation);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: detail() });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    await callbacks[0]!();
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, undefined);
  });

  it("waits for the committed acceptance before replying or scheduling delivery", async () => {
    const receipt = { status: 202 as const, data: accepted(), replayed: false };
    let commit!: (value: typeof receipt) => void;
    vi.mocked(conversationService.sendMessage).mockReturnValue(new Promise((resolve) => { commit = resolve; }));
    const pending = sendMessageRoute(request(sendInput()), ids.conversation);
    await vi.waitFor(() => expect(conversationService.sendMessage).toHaveBeenCalledOnce());
    expect(callbacks).toHaveLength(0);
    commit(receipt);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: receipt.data });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    await callbacks[0]!();
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, ids.run);
  });

  it("preserves a business rejection and never schedules a rejected command", async () => {
    vi.mocked(conversationService.sendMessage).mockRejectedValue(new ServiceFault(409, "revision_conflict", "chat.changed"));
    const response = await sendMessageRoute(request(sendInput()), ids.conversation);
    expect(response.status).toBe(409);
    expect(callbacks).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not schedule work for an unauthenticated read", async () => {
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(401, "unauthenticated", "auth.signInRequired"));
    expect((await getConversationRoute(request(), ids.conversation)).status).toBe(401);
    expect(conversationService.get).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(0);
  });

  it("keeps committed acceptance intact if the host cannot register post-response work", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.after.mockImplementation(() => { throw new Error("host unavailable with private context"); });
      vi.mocked(conversationService.sendMessage).mockResolvedValue({ status: 202, data: accepted(), replayed: false });
      const response = await sendMessageRoute(request(sendInput()), ids.conversation);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ data: accepted() });
      expect(warn).toHaveBeenCalledExactlyOnceWith("unfurl.dispatch.scheduling_unavailable");
      expect(mocks.dispatch).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("reports deferred delivery failure without exposing request data or changing the reply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.dispatch.mockResolvedValue(null);
      vi.mocked(conversationService.get).mockResolvedValue(detail());
      const response = await getConversationRoute(request(), ids.conversation);
      expect(callbacks).toHaveLength(1);
      await callbacks[0]!();
      expect(response.status).toBe(200);
      expect(warn).toHaveBeenCalledExactlyOnceWith("unfurl.dispatch.delivery_deferred");
    } finally { warn.mockRestore(); }
  });
});
