import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readOpenRouterChatStream } from "../../src/server/ai/chat-stream";

const encoder = new TextEncoder();
const id = "gen-stream_123";
const model = "moonshotai/kimi-k2.6";
const provider = "DigitalOcean";

function event(value: unknown, newline = "\n") {
  return `data: ${JSON.stringify(value)}${newline}${newline}`;
}

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    id, model, provider,
    choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    ...overrides,
  };
}

function completeStream(overrides: { id?: string; model?: string; provider?: string; finishReason?: string } = {}) {
  const identity = overrides.id ?? id;
  const returnedModel = overrides.model ?? model;
  const returnedProvider = overrides.provider ?? provider;
  return [
    event({ id: identity, model: returnedModel, provider: returnedProvider,
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }),
    event({ id: identity, model: returnedModel, provider: returnedProvider,
      choices: [{ index: 0, delta: { content: "" }, finish_reason: overrides.finishReason ?? "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.00000125 } }),
    "data: [DONE]\n\n",
  ].join("");
}

function streamedResponse(parts: Uint8Array[], headers: HeadersInit = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  return { body, response: new Response(body, { status: 200, headers }) };
}

describe("OpenRouter Chat Completions SSE transport", () => {
  it("handles comments, multiline CRLF events and a UTF-8 code point split across byte chunks", async () => {
    const first = {
      id, model, provider,
      choices: [{ index: 0, delta: {
        content: "Hello 🧠", refusal: "policy ", reasoning: "private chain",
        annotations: [{ type: "url_citation", url_citation: { url: "https://example.test", title: "Example" } }],
      }, finish_reason: null }],
      reasoning: "also private",
    };
    const pretty = JSON.stringify(first, null, 2).split("\n").map((line) => `data: ${line}`).join("\r\n");
    const exactUsage = event(chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9,
      cost: "EXACT_COST", cost_details: { upstream_inference_cost: "EXACT_UPSTREAM" } } }), "\r\n")
      .replace('"EXACT_COST"', "0.000000123456789012")
      .replace('"EXACT_UPSTREAM"', "0.000000023456789012");
    const raw = [
      ": OPENROUTER PROCESSING\r\n\r\n",
      `${pretty}\r\n\r\n`,
      event(chunk({ choices: [{ index: 0, delta: { content: " world", refusal: "decline" }, finish_reason: "length" }] }), "\r\n"),
      exactUsage,
      "data: [DONE]\r\n\r\n",
    ].join("");
    const bytes = encoder.encode(raw);
    const brain = encoder.encode("🧠");
    const brainStart = bytes.findIndex((value, index) => brain.every((item, offset) => bytes[index + offset] === item));
    expect(brainStart).toBeGreaterThan(0);
    const parts = [bytes.slice(0, brainStart + 1), bytes.slice(brainStart + 1, brainStart + 3), bytes.slice(brainStart + 3)];
    const { body, response } = streamedResponse(parts, { "x-generation-id": id });
    const identities: string[] = [];

    const result = await readOpenRouterChatStream(response, { onIdentity: async (value) => { identities.push(value); } });

    expect(identities).toEqual([id, id]);
    expect(result.responseDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.value).toEqual({
      id, model, provider,
      choices: [{ finish_reason: "length", message: {
        content: "Hello 🧠 world", refusal: "policy decline",
        annotations: [{ type: "url_citation", url_citation: { url: "https://example.test", title: "Example" } }],
      } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9,
        cost: "0.000000123456789012", cost_details: { upstream_inference_cost: "0.000000023456789012" } },
    });
    expect(JSON.stringify(result.value)).not.toContain("private chain");
    expect(JSON.stringify(result.value)).not.toContain("reasoning");
    expect(body.locked).toBe(false);
  });

  it("accepts OpenRouter's repeated terminal choice in the final usage frame", async () => {
    const raw = completeStream({ finishReason: "refused" });
    const onIdentity = vi.fn(async () => undefined);
    const { response } = streamedResponse([encoder.encode(raw)]);

    await expect(readOpenRouterChatStream(response, { onIdentity })).resolves.toMatchObject({
      value: { id, choices: [{ finish_reason: "refused", message: { content: "Hello" } }],
        usage: { cost: "0.00000125" } },
    });
    expect(onIdentity).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("accepts provider metadata on only one normal chunk without inventing it for the others", async () => {
    const raw = [
      event({ id, model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }),
      event({ id, model, provider, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      event({ id, model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
      "data: [DONE]\n\n",
    ].join("");
    const { response } = streamedResponse([encoder.encode(raw)]);

    await expect(readOpenRouterChatStream(response, { onIdentity: async () => undefined })).resolves.toMatchObject({
      value: { id, model, provider },
    });
  });

  it("commits header identity before an aborted body read and preserves the abort exception", async () => {
    const abort = new DOMException("timed out", "AbortError");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(abort); } });
    const onIdentity = vi.fn(async () => undefined);
    const response = new Response(body, { status: 200, headers: { "x-generation-id": id } });

    await expect(readOpenRouterChatStream(response, { onIdentity })).rejects.toBe(abort);
    expect(onIdentity).toHaveBeenCalledExactlyOnceWith(id);
    expect(body.locked).toBe(false);
  });

  it.each([
    ["header/chunk ID", { header: id, raw: completeStream({ id: "gen-other" }) }],
    ["chunk ID", { raw: [event(chunk()), event(chunk({ id: "gen-other" })), event(chunk({ choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("") }],
    ["model", { raw: [event(chunk()), event(chunk({ model: "different/model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })), event(chunk({ model: "different/model", choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("") }],
    ["provider", { raw: [event(chunk()), event(chunk({ provider: "Another", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })), event(chunk({ provider: "Another", choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("") }],
  ])("rejects conflicting %s metadata", async (_label, fixture) => {
    const headers: HeadersInit = "header" in fixture ? { "x-generation-id": fixture.header } : {};
    const { response } = streamedResponse([encoder.encode(fixture.raw)], headers);
    await expect(readOpenRouterChatStream(response, { onIdentity: async () => undefined })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it.each([
    ["has no ID", { error: { code: "server_error", message: "private upstream detail" } }, {}],
    ["uses a non-generation completion ID", { id: "cmpl-abc123", model, error: { code: "server_error", message: "private upstream detail" },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }, { "x-generation-id": id }],
  ])("classifies a first HTTP 200 SSE error frame that %s as unavailable", async (_label, errorFrame, headers) => {
    const { response } = streamedResponse([encoder.encode(event(errorFrame))], headers);
    const onIdentity = vi.fn(async () => undefined);
    await expect(readOpenRouterChatStream(response, { onIdentity })).rejects.toMatchObject({ code: "unavailable" });
    expect(onIdentity).toHaveBeenCalledTimes("x-generation-id" in headers ? 1 : 0);
    if ("x-generation-id" in headers) expect(onIdentity).toHaveBeenCalledWith(id);
  });

  it.each([
    ["malformed JSON", "data: {not-json}\n\ndata: [DONE]\n\n"],
    ["missing DONE", completeStream().replace("data: [DONE]\n\n", "")],
    ["missing final usage", [event(chunk()), event(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })), "data: [DONE]\n\n"].join("")],
    ["missing finish reason", [event(chunk()), event(chunk({ choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("")],
    ["missing provider evidence", completeStream().replaceAll(`,"provider":"${provider}"`, "")],
    ["non-zero choice", [event(chunk({ choices: [{ index: 1, delta: { content: "x" }, finish_reason: "stop" }] })), event(chunk({ choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("")],
    ["multiple choices", [event(chunk({ choices: [
      { index: 0, delta: { content: "a" }, finish_reason: "stop" },
      { index: 1, delta: { content: "b" }, finish_reason: "stop" },
    ] })), event(chunk({ choices: [], usage: { prompt_tokens: 1 } })), "data: [DONE]\n\n"].join("")],
  ])("rejects %s as invalid provider output", async (_label, raw) => {
    const { response } = streamedResponse([encoder.encode(raw)]);
    await expect(readOpenRouterChatStream(response, { onIdentity: async () => undefined })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("rejects truncated UTF-8 rather than treating an aborted text decoder as completed JSON", async () => {
    const raw = encoder.encode(completeStream());
    const broken = new Uint8Array([...raw.slice(0, -2), 0xf0, 0x9f]);
    const { response } = streamedResponse([broken]);
    await expect(readOpenRouterChatStream(response, { onIdentity: async () => undefined })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("bounds raw SSE bytes, cancels the source and releases the reader lock", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(completeStream())); },
      cancel,
    });
    const response = new Response(body, { status: 200, headers: { "x-generation-id": id } });

    await expect(readOpenRouterChatStream(response, { maxBytes: 24, onIdentity: async () => undefined })).rejects.toMatchObject({ code: "invalid_output" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["not-a-generation", `gen-${"a".repeat(201)}`])("rejects invalid OpenRouter identity %s", async (invalidId) => {
    const { response } = streamedResponse([encoder.encode(completeStream())], { "x-generation-id": invalidId });
    const onIdentity = vi.fn(async () => undefined);
    await expect(readOpenRouterChatStream(response, { onIdentity })).rejects.toMatchObject({ code: "invalid_output" });
    expect(onIdentity).not.toHaveBeenCalled();
  });
});
