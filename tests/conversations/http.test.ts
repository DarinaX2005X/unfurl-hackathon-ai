import { describe, expect, it, vi } from "vitest";
import { createHttpConversations } from "../../src/application/http-conversations";
import { createHttpApplication } from "../../src/application/http-application";
import { accepted, detail, ids, pending, sendInput } from "./fixtures";

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });

describe("conversation HTTP clients", () => {
  it("sends stable mutation keys and private no-store requests across a retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost connection")).mockResolvedValueOnce(json(detail().composerDraft));
    const client = createHttpConversations(fetcher);
    const input = { expectedRevision: 1, text: "", pendingMessages: [pending] };
    expect((await client.saveComposer(ids.conversation, input, ids.key)).ok).toBe(false);
    expect((await client.saveComposer(ids.conversation, input, ids.key)).ok).toBe(true);
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe(`/api/v1/conversations/${ids.conversation}/composer`);
      expect(call[1]).toMatchObject({ method: "PUT", cache: "no-store", credentials: "same-origin", headers: { "Idempotency-Key": ids.key }, body: JSON.stringify(input) });
    }
  });
  it("does not substitute browser history for invalid or unavailable responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...detail(), assistantClaim: true })).mockRejectedValueOnce(new Error("offline"));
    const client = createHttpConversations(fetcher);
    expect((await client.get(ids.conversation)).ok).toBe(false);
    expect((await client.list()).ok).toBe(false);
  });
  it("handles empty delete acknowledgement and preserves revision errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "revision_conflict", messageKey: "chat.changed", retryable: false, requestId: ids.key }, currentRevision: 4 }), { status: 409 }));
    const client = createHttpConversations(fetcher);
    expect(await client.remove(ids.conversation, { expectedRevision: 1 }, ids.key)).toEqual({ ok: true, data: null });
    expect(await client.rename(ids.conversation, { expectedRevision: 1, title: "Changed" }, ids.key)).toMatchObject({ ok: false, error: { currentRevision: 4 } });
  });
  it("rejects an unrelated acceptance and never reports unavailable catalog data as an empty page", async () => {
    const receipt = accepted();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...receipt, message: { ...receipt.message, clientRequestId: ids.key } }, 202));
    const app = createHttpApplication(fetcher);
    expect((await app.sendMessage(sendInput())).ok).toBe(false);
    expect(await app.listLibrary()).toMatchObject({ ok: false, error: { error: { code: "service_unavailable" } } });
  });
  it("refuses legacy input without server context instead of inventing branch or revision IDs", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const app = createHttpApplication(fetcher);
    // @ts-expect-error Deliberately exercise a pre-migration caller at the runtime boundary.
    expect(await app.sendMessage({ requestId: ids.request, conversationId: ids.conversation, messageId: ids.message, text: "A local draft" }))
      .toMatchObject({ ok: false, error: { error: { code: "invalid_input" } } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts account-invalidated requests instead of returning a late result", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return json(detail()); });
    await expect(createHttpConversations(fetcher).get(ids.conversation, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
