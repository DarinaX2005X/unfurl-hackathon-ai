import type { CloudSendMessageInput, ConversationDetail, PendingUserMessage } from "../../src/domain/conversations";
import type { SendMessageResult } from "../../src/application/ports";

export const ids = {
  actor: "10000000-0000-4000-8000-000000000001", otherActor: "10000000-0000-4000-8000-000000000002",
  session: "10000000-0000-4000-8000-000000000003", conversation: "10000000-0000-4000-8000-000000000004",
  branch: "10000000-0000-4000-8000-000000000005", message: "10000000-0000-4000-8000-000000000006",
  request: "10000000-0000-4000-8000-000000000007", run: "10000000-0000-4000-8000-000000000008",
  source: "10000000-0000-4000-8000-000000000009", key: "10000000-0000-4000-8000-000000000010",
};
export const at = "2026-10-25T10:00:00.000Z";
export const actor = { id: ids.actor, sessionId: ids.session, email: null };
export const pending: PendingUserMessage = { messageId: ids.message, requestId: ids.request, text: "Explain how this works", userLocale: "en" };
export function detail(): ConversationDetail {
  return {
    conversation: { id: ids.conversation, ownerId: ids.actor, title: "A question", activeBranchId: ids.branch, revision: 1, createdAt: at, updatedAt: at },
    composerDraft: { conversationId: ids.conversation, text: "", pendingMessages: [pending], revision: 1, updatedAt: at },
    messages: [], activeTurn: null, artifacts: [],
  };
}
export function sendInput(): CloudSendMessageInput {
  return { ...pending, conversationId: ids.conversation, expectedRevision: 1, branchId: ids.branch, parentMessageId: null };
}
export function accepted(input = sendInput()): SendMessageResult {
  return {
    message: { id: input.messageId, conversationId: input.conversationId, branchId: input.branchId, parentMessageId: input.parentMessageId,
      role: "user", status: "complete", parts: [{ type: "text", text: input.text }], clientRequestId: input.requestId, createdAt: at },
    run: { id: ids.run, ownerId: ids.actor, conversationId: input.conversationId, branchId: input.branchId, inputMessageId: input.messageId,
      status: "queued", lastSeq: 1, error: null, createdAt: at, updatedAt: at },
  };
}
export function conversationRow(owner = ids.actor) {
  return { id: ids.conversation, owner_id: owner, title: "A question", active_branch_id: ids.branch, revision: 1, created_at: at, updated_at: at };
}
export function composerRow() {
  return { conversation_id: ids.conversation, text: "", pending_messages: [pending], revision: 1, updated_at: at };
}
