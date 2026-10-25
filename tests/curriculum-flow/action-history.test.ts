import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readActionHistory } from "../../src/server/conversations/repository";
import type { Actor } from "../../src/server/auth/actor";
import type { Conversation } from "../../src/domain/generation";
import type { DbTransaction } from "../../src/server/db";
import { ConversationActionPageSchema } from "../../src/domain/conversations";
import { ids, now } from "./fixtures";
import { stableExecutionId } from "../../src/server/runs/identity";

const actor = { id: ids.actor } as Actor;
const conversation: Conversation = { id: ids.conversation, ownerId: ids.actor, title: "Research", activeBranchId: ids.sample,
  revision: 3, createdAt: now, updatedAt: now };
function group(index: number) {
  const invocationId = stableExecutionId(ids.request, `action:${index}`), at = new Date(Date.parse(now) + index * 1000).toISOString();
  return { invocation_id: invocationId, started_at: at, events: [
    { id: stableExecutionId(invocationId, "start"), runId: ids.request, branchId: ids.sample, seq: index * 2 + 1, at,
      type: "action.started", invocationId, action: "search", labelKey: "generation.search", details: { query: `Real query ${index}` } },
    { id: stableExecutionId(invocationId, "complete"), runId: ids.request, branchId: ids.sample, seq: index * 2 + 2, at,
      type: "action.completed", invocationId, resultSummary: "Candidates saved", sourceIds: [], details: { candidateCount: 3 } },
  ] };
}

it("pages whole public invocations and binds cursors to the current visible branch", async () => {
  const query = vi.fn(async () => ({ rows: [group(3), group(2), group(1)] }));
  const tx = { query } as unknown as DbTransaction;
  const page = await readActionHistory(tx, actor, conversation, { limit: 2 });
  expect(page.items.map((event) => event.type)).toEqual(["action.started", "action.completed", "action.started", "action.completed"]);
  expect(page.items.map((event) => event.invocationId)).toEqual([group(2).invocation_id, group(2).invocation_id, group(3).invocation_id, group(3).invocation_id]);
  expect(page).toMatchObject({ conversationId: conversation.id, branchId: conversation.activeBranchId });
  const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
  expect(cursor).toEqual({ branchId: conversation.activeBranchId, at: group(2).started_at, invocationId: group(2).invocation_id });
  await expect(readActionHistory(tx, actor, { ...conversation, activeBranchId: ids.missing }, { cursor: page.nextCursor! })).rejects.toMatchObject({ status: 409 });
  await expect(readActionHistory(tx, actor, conversation, { cursor: "invalid!" })).rejects.toMatchObject({ status: 400 });
  expect(query).toHaveBeenCalledOnce();
  expect(ConversationActionPageSchema.safeParse({ ...page, branchId: ids.missing }).success).toBe(false);
});
