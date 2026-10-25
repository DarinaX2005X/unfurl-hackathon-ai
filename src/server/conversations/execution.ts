import "server-only";
import type { CloudSendMessageInput } from "../../domain/conversations";
import type { AgentTurnRun, ChatMessage, Conversation } from "../../domain/generation";
import type { Actor } from "../auth/actor";
import type { DbTransaction } from "../db";

/** The real runtime supplies this producer. No browser DTO can provide it. */
export interface ConversationExecution {
  /** Check the actual execution capability before entering the database transaction. */
  assertAvailable(actor: Actor, input: CloudSendMessageInput): Promise<void>;
  /** Persist the turn, first event and execution outbox in this same transaction. No provider calls. */
  enqueue(tx: DbTransaction, input: { actor: Actor; conversation: Conversation; message: ChatMessage }): Promise<AgentTurnRun>;
  /** Persist cancellation of every active turn/course job in this conversation, with its events/outbox. */
  cancelConversation?(tx: DbTransaction, actor: Actor, conversationId: string): Promise<void>;
}
