import { describe, expect, it } from "vitest";
import { CloudSendMessageInputSchema, ConversationDetailSchema, ImportConversationInputSchema, PendingUserMessageSchema, SaveComposerInputSchema, unacceptedIntents } from "../../src/domain/conversations";
import { accepted, at, detail, ids, pending, sendInput } from "../conversations/fixtures";

describe("cloud conversation boundary", () => {
  it("accepts only user-owned pending content and preserves entered whitespace", () => {
    expect(PendingUserMessageSchema.parse({ ...pending, text: "  A question\n" }).text).toBe("  A question\n");
    for (const claim of [{ role: "assistant" }, { delivery: "accepted" }, { runId: ids.run }, { artifacts: [] }, { ownerId: ids.actor }]) {
      expect(PendingUserMessageSchema.safeParse({ ...pending, ...claim }).success).toBe(false);
    }
    expect(PendingUserMessageSchema.safeParse({ ...pending, text: " \n " }).success).toBe(false);
  });
  it("bounds buffers by unique identities, count, text and UTF-8 bytes without truncation", () => {
    const base = { expectedRevision: 1, text: "", pendingMessages: [pending] };
    expect(SaveComposerInputSchema.safeParse(base).success).toBe(true);
    expect(SaveComposerInputSchema.safeParse({ ...base, pendingMessages: [pending, pending] }).success).toBe(false);
    expect(SaveComposerInputSchema.safeParse({ ...base, text: "x".repeat(20_001) }).success).toBe(false);
    const large = Array.from({ length: 100 }, () => ({ ...pending, messageId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: "界".repeat(20_000) }));
    expect(SaveComposerInputSchema.safeParse({ ...base, pendingMessages: large }).success).toBe(false);
    expect(large[0]?.text).toHaveLength(20_000);
    expect(SaveComposerInputSchema.safeParse({ ...base, pendingMessages: Array.from({ length: 101 }, () => ({ ...pending, messageId: crypto.randomUUID(), requestId: crypto.randomUUID() })) }).success).toBe(false);
  });
  it("requires revision, branch and parent context for every message", () => {
    expect(CloudSendMessageInputSchema.safeParse(sendInput()).success).toBe(true);
    for (const key of ["expectedRevision", "branchId", "parentMessageId"] as const) {
      const value = { ...sendInput() } as Record<string, unknown>;
      delete value[key];
      expect(CloudSendMessageInputSchema.safeParse(value).success).toBe(false);
    }
  });
  it("rejects mixed-account/branch projections and reconciles accepted delivery identities", () => {
    const value = detail();
    value.activeTurn = accepted().run;
    expect(ConversationDetailSchema.safeParse(value).success).toBe(true);
    expect(ConversationDetailSchema.safeParse({ ...value, activeTurn: { ...value.activeTurn, ownerId: ids.otherActor } }).success).toBe(false);
    expect(ConversationDetailSchema.safeParse({ ...value, composerDraft: { ...value.composerDraft, conversationId: ids.source } }).success).toBe(false);
    expect(unacceptedIntents([pending], [accepted().message])).toEqual([]);
  });
  it("imports explicit user-source fields without accepting local authority claims", () => {
    const value = { sourceId: ids.source, sourceRevision: 7, title: "Earlier chat", composerText: "Keep this text", userMessages: [{ sourceMessageId: ids.message, text: "An earlier question", sourceCreatedAt: at }], sourceCreatedAt: at, sourceUpdatedAt: at };
    expect(ImportConversationInputSchema.safeParse(value).success).toBe(true);
    for (const claim of [{ messages: [] }, { artifacts: [] }, { readyVersionId: ids.run }, { branchId: ids.branch }, { ownerId: ids.actor }]) expect(ImportConversationInputSchema.safeParse({ ...value, ...claim }).success).toBe(false);
    expect(ImportConversationInputSchema.safeParse({ ...value, userMessages: [{ ...value.userMessages[0], role: "assistant" }] }).success).toBe(false);
  });
});
