import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { ConversationSchema } from "../../domain/generation";
import {
  CloudSendMessageInputSchema, ComposerDraftSchema, ConversationDetailSchema, ConversationQuerySchema,
  CreateConversationInputSchema, DeleteConversationInputSchema, ImportConversationInputSchema,
  ImportConversationResultSchema, RenameConversationInputSchema, SaveComposerInputSchema, SendMessageResultSchema,
  type CloudSendMessageInput, type ConversationQuery, type CreateConversationInput, type DeleteConversationInput,
  type ImportConversationInput, type RenameConversationInput, type SaveComposerInput,
} from "../../domain/conversations";
import type { Actor } from "../auth/actor";
import { ServiceFault, unavailable } from "../auth/errors";
import { withActorTransaction, withSystemTransaction, type DbTransaction } from "../db";
import { executeIdempotentInTransaction, requestDigest, type MutationReceipt } from "../idempotency";
import type { ConversationExecution } from "./execution";
import { getConversationExecution } from "../runs/composition";
import * as repository from "./repository";

export interface ConversationTransactions {
  actor<T>(actor: Actor, work: (tx: DbTransaction) => Promise<T>): Promise<T>;
  execution<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T>;
}
interface ServiceOptions { execution?: ConversationExecution; transactions?: ConversationTransactions; createId?: () => string }

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
  return parsed.data;
}
function titleFromText(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim().replace(/\s+/g, " ") ?? "New chat";
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first;
}

export function createConversationService(options: ServiceOptions = {}) {
  const transactions: ConversationTransactions = options.transactions ?? {
    actor: withActorTransaction,
    execution: (work) => withSystemTransaction("run_execution", work),
  };
  const createId = options.createId ?? (() => crypto.randomUUID());

  async function mutate<T>(actor: Actor, operation: string, key: string, body: unknown, schema: z.ZodType<T>, work: (tx: DbTransaction) => Promise<MutationReceipt<T>>, execution = false) {
    input(IdSchema, key);
    const run = (tx: DbTransaction) => executeIdempotentInTransaction(tx, actor, { operation, key, body, parseResult: schema }, work);
    return execution ? transactions.execution(run) : transactions.actor(actor, run);
  }

  async function checkReplayedConversation<T extends { replayed: boolean }>(actor: Actor, conversationId: string, receipt: T): Promise<T> {
    // A cached receipt must never resurrect a conversation deleted after that operation.
    if (receipt.replayed) await transactions.actor(actor, (tx) => repository.requireConversation(tx, actor, conversationId));
    return receipt;
  }

  return {
    list(actor: Actor, query: ConversationQuery = {}) {
      return transactions.actor(actor, (tx) => repository.listConversations(tx, actor, input(ConversationQuerySchema, query)));
    },
    get(actor: Actor, id: string) {
      input(IdSchema, id);
      return transactions.actor(actor, async (tx) => repository.readDetail(tx, actor, await repository.requireConversation(tx, actor, id)));
    },
    async create(actor: Actor, value: CreateConversationInput, key: string) {
      const body = input(CreateConversationInputSchema, value);
      const receipt = await mutate(actor, "conversation.create", key, body, ConversationDetailSchema, async (tx) => ({
        status: 201, data: await repository.insertConversation(tx, actor, {
          id: createId(), branchId: createId(), title: body.title ?? titleFromText(body.composerText), text: body.composerText, pendingMessages: [],
        }),
      }));
      return checkReplayedConversation(actor, receipt.data.conversation.id, receipt);
    },
    async rename(actor: Actor, id: string, value: RenameConversationInput, key: string) {
      input(IdSchema, id);
      const body = input(RenameConversationInputSchema, value);
      const receipt = await mutate(actor, "conversation.rename", key, { id, ...body }, ConversationSchema, async (tx) => {
        await repository.requireConversation(tx, actor, id, "update");
        return { status: 200, data: await repository.renameConversation(tx, actor, id, body.expectedRevision, body.title) };
      });
      return checkReplayedConversation(actor, id, receipt);
    },
    async saveComposer(actor: Actor, id: string, value: SaveComposerInput, key: string) {
      input(IdSchema, id);
      const body = input(SaveComposerInputSchema, value);
      const receipt = await mutate(actor, "conversation.composer", key, { id, ...body }, ComposerDraftSchema, async (tx) => {
        const conversation = await repository.requireConversation(tx, actor, id, "update");
        return { status: 200, data: await repository.saveComposer(tx, actor, conversation, body) };
      });
      return checkReplayedConversation(actor, id, receipt);
    },
    async remove(actor: Actor, id: string, value: DeleteConversationInput, key: string) {
      input(IdSchema, id);
      const body = input(DeleteConversationInputSchema, value);
      return mutate(actor, "conversation.delete", key, { id, ...body }, z.null(), async (tx) => {
        const conversation = await repository.requireConversation(tx, actor, id, "update");
        if (conversation.revision !== body.expectedRevision) throw repository.revisionConflict(conversation.revision);
        if (await repository.hasActiveRuns(tx, actor, id)) {
          if (!options.execution?.cancelConversation) throw unavailable("generation.unavailable");
          await options.execution.cancelConversation(tx, actor, id);
          if (await repository.hasActiveRuns(tx, actor, id)) throw unavailable("generation.cancellationUnconfirmed");
        }
        await repository.deleteConversation(tx, actor, conversation);
        return { status: 204, data: null };
      }, true);
    },
    async importLocal(actor: Actor, value: ImportConversationInput, key: string) {
      const body = input(ImportConversationInputSchema, value);
      const digest = requestDigest(body);
      const receipt = await mutate(actor, "conversation.import", key, body, ImportConversationResultSchema, async (tx) => {
        // Source-level serialization also covers two different idempotency keys importing the same source.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${actor.id}:${body.sourceId}`]);
        const existing = await tx.query<{ conversation_id: string; source_digest: string; deleted_at: Date | string | null }>(
          "SELECT conversation_id, source_digest, deleted_at FROM unfurl.local_imports WHERE actor_id = $1 AND source_id = $2 FOR UPDATE", [actor.id, body.sourceId],
        );
        const previous = existing.rows[0];
        if (previous) {
          if (previous.deleted_at) throw new ServiceFault(409, "idempotency_conflict", "chat.importDeleted");
          if (previous.source_digest !== digest) throw new ServiceFault(409, "idempotency_conflict", "chat.importChanged");
          const conversation = await repository.requireConversation(tx, actor, previous.conversation_id);
          return { status: 200, data: { sourceId: body.sourceId, conversation: await repository.readDetail(tx, actor, conversation) } };
        }
        const pendingMessages = body.userMessages.map((message) => ({
          messageId: createId(), requestId: createId(), text: message.text,
          ...(message.userLocale ? { userLocale: message.userLocale } : {}),
        }));
        input(SaveComposerInputSchema, { expectedRevision: 1, text: body.composerText, pendingMessages });
        const conversation = await repository.insertConversation(tx, actor, {
          id: createId(), branchId: createId(), title: body.title, text: body.composerText, pendingMessages,
        });
        await tx.query("INSERT INTO unfurl.local_imports (actor_id, source_id, conversation_id, source_digest) VALUES ($1, $2, $3, $4)", [actor.id, body.sourceId, conversation.conversation.id, digest]);
        return { status: 201, data: { sourceId: body.sourceId, conversation } };
      });
      return checkReplayedConversation(actor, receipt.data.conversation.conversation.id, receipt);
    },
    async sendMessage(actor: Actor, value: CloudSendMessageInput, key: string) {
      const body = input(CloudSendMessageInputSchema, value);
      if (body.requestId !== key) throw new ServiceFault(400, "invalid_input", "chat.requestIdentityMismatch");
      // A lost accepted response remains recoverable during a later provider outage.
      const replay = await transactions.actor(actor, async (tx) => {
        await repository.requireConversation(tx, actor, body.conversationId);
        const result = await tx.query<{ request_digest: string; response_status: number | null; response_data: unknown }>(
          "SELECT request_digest, response_status, response_data FROM unfurl.idempotency WHERE actor_id = $1 AND operation = $2 AND key = $3",
          [actor.id, "conversation.send", key],
        );
        const row = result.rows[0];
        if (!row) return null;
        if (row.request_digest !== requestDigest(body)) throw new ServiceFault(409, "idempotency_conflict", "request.idempotencyConflict");
        if (row.response_status !== 202) throw unavailable("chat.unavailable");
        return { status: 202 as const, data: SendMessageResultSchema.parse(row.response_data), replayed: true };
      });
      if (replay) return replay;
      if (!options.execution) throw unavailable("generation.unavailable");
      await options.execution.assertAvailable(actor, body);

      return mutate(actor, "conversation.send", key, body, SendMessageResultSchema, async (tx) => {
        const conversation = await repository.requireConversation(tx, actor, body.conversationId, "update");
        if (conversation.revision !== body.expectedRevision || conversation.activeBranchId !== body.branchId) throw repository.revisionConflict(conversation.revision);
        const messages = await repository.readMessages(tx, conversation);
        if ((messages.at(-1)?.id ?? null) !== body.parentMessageId) throw repository.revisionConflict(conversation.revision);
        const activeTurn = await repository.readActiveTurn(tx, actor, conversation);
        if (activeTurn?.status === "queued" || activeTurn?.status === "running") throw new ServiceFault(409, "revision_conflict", "chat.turnInProgress", false, { currentRevision: conversation.revision });
        const composer = await repository.readComposer(tx, conversation.id);
        const pending = composer.pendingMessages.find((message) => message.messageId === body.messageId && message.requestId === body.requestId);
        if (!pending || pending.text !== body.text || pending.userLocale !== body.userLocale) throw new ServiceFault(409, "revision_conflict", "chat.messageNotSaved", false, { currentRevision: composer.revision });
        const message = await repository.insertUserMessage(tx, conversation, body);
        const run = await options.execution!.enqueue(tx, { actor, conversation, message });
        const data = SendMessageResultSchema.parse({ message, run });
        if (run.ownerId !== actor.id || run.status !== "queued" || run.lastSeq < 1) throw unavailable("generation.acceptanceUnconfirmed");
        await repository.touchConversation(tx, actor, conversation);
        await repository.saveComposer(tx, actor, conversation, {
          expectedRevision: composer.revision, text: composer.text,
          pendingMessages: composer.pendingMessages.filter((intent) => intent.messageId !== body.messageId),
        });
        return { status: 202, data };
      }, true);
    },
  };
}

// Keep runtime construction lazy inside the execution adapter, while ensuring
// the production singleton can actually admit and enqueue accepted turns.
export const conversationService = createConversationService({ execution: getConversationExecution() });
export type ConversationService = ReturnType<typeof createConversationService>;
