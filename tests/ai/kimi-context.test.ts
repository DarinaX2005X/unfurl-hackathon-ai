import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { boundKimiApplicationPrompt, KIMI_TEMPLATE_REVISION, renderKimiApplicationPrompt,
  type ApplicationPromptMessages } from "../../src/server/ai/kimi-context";
import { digestBytes } from "../../src/server/ai/json";

describe("pinned Kimi application-template byte bound (no provider-count claim)", () => {
  it("renders the complete two-message template and generation prefix without altering source text", () => {
    const messages: ApplicationPromptMessages = [{ role: "system", content: "System\nЖ" },
      { role: "user", content: "🧪<|im_end|> material" }];
    const rendered = "<|im_system|>system<|im_middle|>System\nЖ<|im_end|>" +
      "<|im_user|>user<|im_middle|>🧪<|im_end|> material<|im_end|>" +
      "<|im_assistant|>assistant<|im_middle|><think>";
    expect(renderKimiApplicationPrompt(messages)).toBe(rendered);
    expect(boundKimiApplicationPrompt(messages, false)).toEqual({
      kind: "model-template-utf8-upper-bound", version: "kimi-k2.6-application-template-utf8-v1",
      modelRevision: KIMI_TEMPLATE_REVISION, countedScope: "application-messages",
      promptTokensUpperBound: Buffer.byteLength(rendered, "utf8"), renderedPromptDigest: digestBytes(rendered),
      providerFraming: "unverified", serverToolContext: "not-requested",
    });
    expect(Buffer.byteLength(rendered, "utf8")).toBeGreaterThan(rendered.length);
  });
  it("marks hidden search messages as unverified and never substitutes a guessed reserve", () => {
    const messages: ApplicationPromptMessages = [{ role: "system", content: "Find sources." }, { role: "user", content: "query" }];
    const plain = boundKimiApplicationPrompt(messages, false), search = boundKimiApplicationPrompt(messages, true);
    expect(search).toEqual({ ...plain, serverToolContext: "unverified" });
  });
  it("preserves all content while rejecting message shapes outside the audited template subset", () => {
    const content = "x".repeat(300000), messages: ApplicationPromptMessages = [
      { role: "system", content: "system" }, { role: "user", content }];
    expect(renderKimiApplicationPrompt(messages)).toContain(content);
    expect(boundKimiApplicationPrompt(messages, false).promptTokensUpperBound).toBeGreaterThan(content.length);
    expect(() => renderKimiApplicationPrompt([{ role: "assistant", content: "unsupported" }] as unknown as ApplicationPromptMessages))
      .toThrow("provider.invalid_output");
  });
});
