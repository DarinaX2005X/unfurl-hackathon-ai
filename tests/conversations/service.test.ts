import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createConversationService, type ConversationTransactions } from "../../src/server/conversations/service";
import { requireConversation, saveComposer } from "../../src/server/conversations/repository";
import { requestDigest } from "../../src/server/idempotency";
import type { DbTransaction } from "../../src/server/db";
import type { ConversationExecution } from "../../src/server/conversations/execution";
import { accepted, actor, at, composerRow, conversationRow, detail, ids, pending, sendInput } from "./fixtures";

function transaction(query: ReturnType<typeof vi.fn>): DbTransaction { return { query } as unknown as DbTransaction; }
function dependencies(actorTx: DbTransaction, executionTx: DbTransaction = actorTx) {
  const commits: string[] = [];
  const transactions: ConversationTransactions = {
    actor: async (_actor, work) => { const result = await work(actorTx); commits.push("actor"); return result; },
    execution: async (work) => {
      try { const result = await work(executionTx); commits.push("execution"); return result; }
      catch (error) { commits.push("rollback"); throw error; }
    },
  };
  return { transactions, commits };
}
const rows = (items: unknown[] = []) => ({ rows: items, rowCount: items.length });

describe("conversation service authority", () => {
  it("leaves persisted user intent untouched when no execution producer exists", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM unfurl.conversations") ? rows([conversationRow()]) : rows());
    const deps = dependencies(transaction(query));
    await expect(createConversationService({ transactions: deps.transactions }).sendMessage(actor, sendInput(), ids.request))
      .rejects.toMatchObject({ status: 503, messageKey: "generation.unavailable" });
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
    expect(deps.commits).toEqual(["actor"]);
  });

  it("returns an earlier acceptance during an outage without creating another run", async () => {
    const receipt = accepted();
    const query = vi.fn(async (sql: string) => sql.includes("FROM unfurl.conversations") ? rows([conversationRow()])
      : rows([{ request_digest: requestDigest(sendInput()), response_status: 202, response_data: receipt }]));
    const service = createConversationService({ transactions: dependencies(transaction(query)).transactions });
    await expect(service.sendMessage(actor, sendInput(), ids.request)).resolves.toEqual({ status: 202, data: receipt, replayed: true });
    await expect(service.sendMessage(actor, { ...sendInput(), text: "Changed under an old key" }, ids.request)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("explicitly rejects another owner even under a privileged transaction", async () => {
    const actorQuery = vi.fn(async (sql: string) => sql.includes("FROM unfurl.conversations") ? rows([conversationRow()]) : rows());
    const privilegedQuery = vi.fn(async (sql: string) => sql.startsWith("INSERT INTO unfurl.idempotency") ? rows([{ key: ids.request }]) : rows([conversationRow(ids.otherActor)]));
    const enqueue = vi.fn<ConversationExecution["enqueue"]>();
    const deps = dependencies(transaction(actorQuery), transaction(privilegedQuery));
    const service = createConversationService({ transactions: deps.transactions, execution: { assertAvailable: vi.fn(async () => {}), enqueue } });
    await expect(service.sendMessage(actor, sendInput(), ids.request)).rejects.toMatchObject({ status: 404 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(privilegedQuery.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO unfurl.messages"))).toBe(false);
    expect(privilegedQuery.mock.calls.find(([sql]) => sql.includes("FROM unfurl.conversations"))?.[0]).toContain("owner_id = $2 AND deleted_at IS NULL FOR UPDATE");
    expect(deps.commits).toEqual(["actor", "rollback"]);
  });

  it("keeps accepted message, turn, event, outbox and input acknowledgement in one transaction", async () => {
    const receipt = accepted();
    const actorQuery = vi.fn(async (sql: string) => sql.includes("FROM unfurl.conversations") ? rows([conversationRow()]) : rows());
    let inserted = false;
    const messageRow = { id: ids.message, conversation_id: ids.conversation, branch_id: ids.branch, parent_message_id: null, role: "user", status: "complete", parts: receipt.message.parts, client_request_id: ids.request, created_at: at };
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("INSERT INTO unfurl.idempotency")) return rows([{ key: ids.request }]);
      if (sql.includes("FROM unfurl.conversations") || sql.startsWith("UPDATE unfurl.conversations SET revision")) return rows([conversationRow()]);
      if (sql.startsWith("SELECT") && sql.includes("FROM unfurl.messages")) return rows(inserted ? [messageRow] : []);
      if (sql.includes("FROM unfurl.agent_turn_runs")) return rows();
      if (sql.includes("FROM unfurl.composer_drafts")) return rows([composerRow()]);
      if (sql.startsWith("INSERT INTO unfurl.messages")) { inserted = true; return rows([messageRow]); }
      if (sql.startsWith("UPDATE unfurl.composer_drafts")) return rows([{ ...composerRow(), pending_messages: [], revision: 2 }]);
      return rows();
    });
    const tx = transaction(query);
    const enqueue = vi.fn<ConversationExecution["enqueue"]>(async (provided, value) => {
      expect(provided).toBe(tx);
      expect(value.actor.id).toBe(ids.actor);
      expect(value.message).toEqual(receipt.message);
      await provided.query("INSERT runtime turn, first event and outbox");
      return receipt.run;
    });
    const deps = dependencies(transaction(actorQuery), tx);
    const preflight = vi.fn(async () => { expect(query).not.toHaveBeenCalled(); });
    const result = await createConversationService({ transactions: deps.transactions, execution: { assertAvailable: preflight, enqueue } }).sendMessage(actor, sendInput(), ids.request);
    expect(result.data).toEqual(receipt);
    expect(preflight).toHaveBeenCalledOnce();
    const operations = query.mock.calls.map(([sql]) => sql);
    expect(operations.findIndex((sql) => sql.startsWith("INSERT INTO unfurl.messages"))).toBeLessThan(operations.indexOf("INSERT runtime turn, first event and outbox"));
    expect(operations.indexOf("INSERT runtime turn, first event and outbox")).toBeLessThan(operations.findIndex((sql) => sql.startsWith("UPDATE unfurl.idempotency")));
    expect(deps.commits).toEqual(["actor", "execution"]);
  });

  it("does not delete a conversation while cancellation is unavailable", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("INSERT INTO unfurl.idempotency") ? rows([{ key: ids.key }])
      : sql.includes("FROM unfurl.conversations") ? rows([conversationRow()]) : rows([{ active: true }]));
    const deps = dependencies(transaction(query));
    await expect(createConversationService({ transactions: deps.transactions }).remove(actor, ids.conversation, { expectedRevision: 1 }, ids.key))
      .rejects.toMatchObject({ messageKey: "generation.unavailable" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE unfurl.conversations"))).toBe(false);
    expect(deps.commits).toEqual(["rollback"]);
  });

  it("requires the same owner before deleting even when system RLS is bypassed", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("INSERT INTO unfurl.idempotency") ? rows([{ key: ids.key }]) : rows([conversationRow(ids.otherActor)]));
    await expect(createConversationService({ transactions: dependencies(transaction(query)).transactions }).remove(actor, ids.conversation, { expectedRevision: 1 }, ids.key))
      .rejects.toMatchObject({ status: 404 });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE unfurl.conversations"))).toBe(false);
  });
});

describe("composer and import revision safety", () => {
  it("uses conditional composer updates and returns the current revision without overwriting", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM unfurl.composer_drafts") ? rows([{ ...composerRow(), revision: 4 }]) : rows());
    await expect(saveComposer(transaction(query), actor, detail().conversation, { expectedRevision: 1, text: "Keep my new words", pendingMessages: [pending] }))
      .rejects.toMatchObject({ status: 409, details: { currentRevision: 4 } });
    const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE unfurl.composer_drafts"));
    expect(update?.[0]).toContain("WHERE conversation_id = $1 AND revision = $2");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE unfurl.conversations"))).toBe(false);
  });
  it("checks an explicit owner filter even for normal reads", async () => {
    const query = vi.fn(async () => rows());
    await expect(requireConversation(transaction(query), actor, ids.conversation)).rejects.toMatchObject({ status: 404 });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("owner_id = $2 AND deleted_at IS NULL"), [ids.conversation, ids.actor]]);
  });
  it("keeps a deleted import tombstone and rejects changed source content", async () => {
    const importInput = { sourceId: ids.source, sourceRevision: 1, title: "Earlier work", composerText: "Keep", userMessages: [], sourceCreatedAt: at, sourceUpdatedAt: at };
    let deletedAt: string | null = at;
    const query = vi.fn(async (sql: string) => sql.startsWith("INSERT INTO unfurl.idempotency") ? rows([{ key: ids.key }])
      : sql.includes("FROM unfurl.local_imports") ? rows([{ conversation_id: ids.conversation, source_digest: requestDigest(importInput), deleted_at: deletedAt }]) : rows());
    const service = createConversationService({ transactions: dependencies(transaction(query)).transactions });
    await expect(service.importLocal(actor, importInput, ids.key)).rejects.toMatchObject({ messageKey: "chat.importDeleted" });
    deletedAt = null;
    await expect(service.importLocal(actor, { ...importInput, composerText: "Changed source" }, ids.key)).rejects.toMatchObject({ messageKey: "chat.importChanged" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO unfurl.conversations"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });
});
