import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/auth/session", () => ({ requireActor: vi.fn() }));
vi.mock("../../src/server/auth/config", () => ({ requireAuthConfiguration: () => ({ origin: "http://127.0.0.1:3000" }) }));
vi.mock("../../src/server/conversations/service", () => ({ conversationService: { create: vi.fn(), get: vi.fn(), saveComposer: vi.fn(), sendMessage: vi.fn(), importLocal: vi.fn(), list: vi.fn(), rename: vi.fn(), remove: vi.fn() } }));
import { requireActor } from "../../src/server/auth/session";
import { conversationService } from "../../src/server/conversations/service";
import { createConversationRoute, listConversationsRoute, saveComposerRoute, sendMessageRoute } from "../../src/server/conversations/routes";
import { ServiceFault } from "../../src/server/auth/errors";
import { actor, detail, ids, sendInput } from "./fixtures";

function request(path: string, body?: unknown, origin = "http://127.0.0.1:3000") {
  return new NextRequest(`http://127.0.0.1:3000/api/v1/conversations${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": ids.request },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireActor).mockResolvedValue(actor); });

describe("conversation route boundary", () => {
  it("rejects unauthenticated and cross-origin writes before their service mutation", async () => {
    expect((await createConversationRoute(request("", { composerText: "Private" }, "https://other.example"))).status).toBe(403);
    vi.mocked(requireActor).mockRejectedValueOnce(new ServiceFault(401, "unauthenticated", "auth.signInRequired"));
    expect((await createConversationRoute(request("", { composerText: "Private" }))).status).toBe(401);
    expect(conversationService.create).not.toHaveBeenCalled();
  });
  it("allows a valid 20,000-character message and keeps private replies uncached", async () => {
    const input = { ...sendInput(), text: "界".repeat(20_000) };
    vi.mocked(conversationService.sendMessage).mockRejectedValueOnce(new ServiceFault(503, "service_unavailable", "generation.unavailable", true));
    const response = await sendMessageRoute(request(`/${ids.conversation}/messages`, input), ids.conversation);
    expect(response.status).toBe(503);
    expect(conversationService.sendMessage).toHaveBeenCalledWith(actor, input, ids.request);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("rejects authority fields and oversized buffers without invoking persistence", async () => {
    const input = { expectedRevision: 1, text: "Hello", pendingMessages: [], artifacts: [] };
    expect((await saveComposerRoute(request(`/${ids.conversation}/composer`, input), ids.conversation)).status).toBe(400);
    expect((await saveComposerRoute(request(`/${ids.conversation}/composer`, { ...input, text: "x".repeat(2_000_001) }), ids.conversation)).status).toBe(400);
    expect(conversationService.saveComposer).not.toHaveBeenCalled();
  });
  it("validates conversation identity and duplicate list queries", async () => {
    expect((await sendMessageRoute(request(`/${ids.source}/messages`, sendInput()), ids.source)).status).toBe(400);
    expect((await listConversationsRoute(request("?limit=1&limit=2"))).status).toBe(400);
    expect(conversationService.sendMessage).not.toHaveBeenCalled();
    vi.mocked(conversationService.create).mockResolvedValueOnce({ status: 201, data: detail(), replayed: false });
    expect((await createConversationRoute(request("", { composerText: "Saved idea" }))).status).toBe(201);
  });
});
