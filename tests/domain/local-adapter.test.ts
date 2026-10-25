import { describe, expect, it } from "vitest";
import { localApplication } from "../../src/application/local-adapter";
import { ids } from "./fixtures";

const input = { requestId: ids.request, conversationId: ids.conversation, messageId: ids.draft, text: "Teach me how to assess an AI model.", userLocale: "en", expectedRevision: 1, branchId: ids.question, parentMessageId: null };

describe("local application capabilities", () => {
  it("exposes actual empty collections without creating cloud records", async () => {
    expect(await localApplication.capabilities()).toEqual({ generation: false, cloudIdentity: false, cloudPersistence: false });
    expect(await localApplication.listPublic({ q: "models", contentLanguage: "en", limit: 12 }))
      .toEqual({ ok: true, data: { items: [], nextCursor: null } });
    expect(await localApplication.listLibrary()).toEqual({ ok: true, data: { items: [], nextCursor: null } });
    expect(await localApplication.getPublicCourse("models")).toMatchObject({
      ok: false, error: { error: { code: "not_found", retryable: false } },
    });
  });

  it("rejects generation before accepting a message or run and preserves request identity", async () => {
    expect(await localApplication.sendMessage(input)).toEqual({
      ok: false,
      error: { error: { code: "service_unavailable", messageKey: "generation.unavailable", retryable: true, requestId: ids.request } },
    });
  });

  it("returns input errors for invalid requests instead of an availability result", async () => {
    expect(await localApplication.sendMessage({ ...input, text: "   " })).toMatchObject({
      ok: false, error: { error: { code: "invalid_input", retryable: false, requestId: ids.request } },
    });
    expect(await localApplication.listPublic({ limit: -1 })).toMatchObject({
      ok: false, error: { error: { code: "invalid_input", retryable: false } },
    });
  });

  it("honors an already cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(localApplication.sendMessage(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(localApplication.listPublic({}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(localApplication.listLibrary(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(localApplication.getPublicCourse("models", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

