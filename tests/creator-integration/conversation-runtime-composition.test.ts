import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const assertAvailable = vi.fn(async () => {});
  const enqueue = vi.fn();
  return {
    actorTx: null as unknown as { query: ReturnType<typeof vi.fn> },
    executionTx: null as unknown as { query: ReturnType<typeof vi.fn> },
    getConversationExecution: vi.fn(() => ({ assertAvailable, enqueue })),
    assertAvailable,
    enqueue,
  };
});

vi.mock("../../src/server/runs/composition", () => ({
  getConversationExecution: mocks.getConversationExecution,
}));
vi.mock("../../src/server/db", () => ({
  withActorTransaction: async (_actor: unknown, work: (tx: typeof mocks.actorTx) => Promise<unknown>) => work(mocks.actorTx),
  withSystemTransaction: async (_role: string, work: (tx: typeof mocks.executionTx) => Promise<unknown>) => work(mocks.executionTx),
}));

import { conversationService } from "../../src/server/conversations/service";
import { accepted, actor, at, composerRow, conversationRow, ids, sendInput } from "../conversations/fixtures";

const rows = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });

describe("production conversation composition", () => {
  it("admits and enqueues a first-time send through the durable runtime adapter", async () => {
    const receipt = accepted();
    let inserted = false;
    const messageRow = {
      id: ids.message, conversation_id: ids.conversation, branch_id: ids.branch, parent_message_id: null,
      role: "user", status: "complete", parts: receipt.message.parts, client_request_id: ids.request, created_at: at,
    };
    mocks.actorTx = { query: vi.fn(async (sql: string) => sql.includes("FROM unfurl.conversations") ? rows([conversationRow()]) : rows()) };
    mocks.executionTx = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: ids.request }]);
      if (sql.includes("FROM unfurl.conversations") || sql.startsWith("UPDATE unfurl.conversations SET revision")) return rows([conversationRow()]);
      if (sql.startsWith("SELECT") && sql.includes("FROM unfurl.messages")) return rows(inserted ? [messageRow] : []);
      if (sql.includes("FROM unfurl.agent_turn_runs")) return rows();
      if (sql.includes("FROM unfurl.composer_drafts")) return rows([composerRow()]);
      if (sql.startsWith("INSERT INTO unfurl.messages")) { inserted = true; return rows([messageRow]); }
      if (sql.startsWith("UPDATE unfurl.composer_drafts")) return rows([{ ...composerRow(), pending_messages: [], revision: 2 }]);
      return rows();
    }) };
    mocks.enqueue.mockResolvedValue(receipt.run);
    await expect(conversationService.sendMessage(actor, sendInput(), ids.request)).resolves.toMatchObject({ status: 202, data: receipt });
    expect(mocks.assertAvailable).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
