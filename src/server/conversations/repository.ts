import "server-only";
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, type Page } from "../../domain/common";
import { CourseArtifactRefSchema, type CourseArtifactRef } from "../../domain/chat";
import { CurriculumApprovalSchema } from "../../domain/course";
import { ActionEventSchema, AgentTurnRunSchema, ChatMessageSchema, ConversationSchema, type AgentTurnRun, type ChatMessage, type Conversation } from "../../domain/generation";
import { ComposerDraftSchema, ConversationActionPageSchema, ConversationDetailSchema, unacceptedIntents, type ComposerDraft, type ConversationActionQuery, type ConversationDetail, type ConversationQuery, type PendingUserMessage, type SaveComposerInput } from "../../domain/conversations";
import type { Actor } from "../auth/actor";
import { ServiceFault, unavailable } from "../auth/errors";
import type { DbTransaction } from "../db";

type DateValue = Date | string;
export interface ConversationRow { id: string; owner_id: string; title: string; active_branch_id: string; revision: number; created_at: DateValue; updated_at: DateValue }
interface ComposerRow { conversation_id: string; text: string; pending_messages: unknown; revision: number; updated_at: DateValue }
interface MessageRow { id: string; conversation_id: string; branch_id: string; parent_message_id: string | null; role: string; status: string; parts: unknown; client_request_id: string | null; created_at: DateValue }
interface TurnRow { id: string; owner_id: string; conversation_id: string; branch_id: string; input_message_id: string; status: string; last_seq: number; error: unknown; created_at: DateValue; updated_at: DateValue }
interface ArtifactRow { course_id: string; title: string; summary: string; content_language: string; revision: number; ready_version_id: string | null; updated_at: DateValue; document: unknown; approval_requested_revision: number | null; approval_id: string | null; draft_id: string | null; draft_revision: number | null; content_digest: string | null; approved_by: string | null; approved_at: DateValue | null }

const conversationColumns = "id, owner_id, title, active_branch_id, revision, created_at, updated_at";
const messageColumns = "id, conversation_id, branch_id, parent_message_id, role, status, parts, client_request_id, created_at";
const iso = (value: DateValue) => new Date(value).toISOString();
export const missingConversation = () => new ServiceFault(404, "not_found", "chat.notFound");
export const revisionConflict = (revision: number) => new ServiceFault(409, "revision_conflict", "chat.changed", false, { currentRevision: revision });

export function conversationFromRow(row: ConversationRow): Conversation {
  return ConversationSchema.parse({ id: row.id, ownerId: row.owner_id, title: row.title, activeBranchId: row.active_branch_id, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function composerFromRow(row: ComposerRow): ComposerDraft {
  return ComposerDraftSchema.parse({ conversationId: row.conversation_id, text: row.text, pendingMessages: row.pending_messages, revision: row.revision, updatedAt: iso(row.updated_at) });
}
function messageFromRow(row: MessageRow): ChatMessage {
  return ChatMessageSchema.parse({ id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, parentMessageId: row.parent_message_id, role: row.role, status: row.status, parts: row.parts, clientRequestId: row.client_request_id, createdAt: iso(row.created_at) });
}
function turnFromRow(row: TurnRow): AgentTurnRun {
  return AgentTurnRunSchema.parse({ id: row.id, ownerId: row.owner_id, conversationId: row.conversation_id, branchId: row.branch_id, inputMessageId: row.input_message_id, status: row.status, lastSeq: row.last_seq, error: row.error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}

export async function requireConversation(tx: DbTransaction, actor: Actor, id: string, lock: "update" | "share" = "share"): Promise<Conversation> {
  const result = await tx.query<ConversationRow>(
    `SELECT ${conversationColumns} FROM unfurl.conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL ${lock === "update" ? "FOR UPDATE" : "FOR SHARE"}`,
    [id, actor.id],
  );
  const row = result.rows[0];
  // The explicit check also protects callers using the controlled system transaction.
  if (!row || row.owner_id !== actor.id || row.id !== id) throw missingConversation();
  return conversationFromRow(row);
}

const CursorSchema = z.object({ updatedAt: IsoDateTimeSchema, id: IdSchema }).strict();
export async function listConversations(tx: DbTransaction, actor: Actor, query: ConversationQuery): Promise<Page<Conversation>> {
  let cursor: z.infer<typeof CursorSchema> | null = null;
  if (query.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    } catch { throw new ServiceFault(400, "invalid_input", "chat.invalidCursor"); }
  }
  const limit = query.limit ?? 24;
  const result = await tx.query<ConversationRow>(
    `SELECT ${conversationColumns} FROM unfurl.conversations WHERE owner_id = $1 AND deleted_at IS NULL
     AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY updated_at DESC, id DESC LIMIT $4`,
    [actor.id, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const items = result.rows.slice(0, limit).map(conversationFromRow);
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null };
}

export async function readComposer(tx: DbTransaction, conversationId: string): Promise<ComposerDraft> {
  const result = await tx.query<ComposerRow>("SELECT conversation_id, text, pending_messages, revision, updated_at FROM unfurl.composer_drafts WHERE conversation_id = $1", [conversationId]);
  if (!result.rows[0]) throw unavailable("chat.unavailable");
  return composerFromRow(result.rows[0]);
}

export async function readMessages(tx: DbTransaction, conversation: Conversation): Promise<ChatMessage[]> {
  const result = await tx.query<MessageRow>(`SELECT ${messageColumns} FROM unfurl.messages WHERE conversation_id = $1 AND branch_id = $2 ORDER BY created_at, id`, [conversation.id, conversation.activeBranchId]);
  return result.rows.map(messageFromRow);
}

const ActionCursorSchema = z.object({ branchId: IdSchema, at: IsoDateTimeSchema, invocationId: IdSchema }).strict();
export async function readActionHistory(tx: DbTransaction, actor: Actor, conversation: Conversation, query: ConversationActionQuery = {}) {
  let cursor: z.infer<typeof ActionCursorSchema> | null = null;
  if (query.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      cursor = ActionCursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    } catch { throw new ServiceFault(400, "invalid_input", "chat.invalidCursor"); }
    if (cursor.branchId !== conversation.activeBranchId) throw revisionConflict(conversation.revision);
  }
  const limit = query.limit ?? 50;
  const groups = (await tx.query<{ invocation_id: string; started_at: DateValue; events: unknown }>(`WITH visible_events AS (
    SELECT e.* FROM unfurl.agent_turn_events e
    JOIN unfurl.agent_turn_runs r ON r.id=e.run_id AND r.owner_id=$2 AND r.conversation_id=$1 AND r.branch_id=$3
    JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=$2 AND c.active_branch_id=$3 AND c.deleted_at IS NULL
    JOIN unfurl.messages input ON input.id=r.input_message_id AND input.conversation_id=$1 AND input.branch_id=$3
      AND input.role='user' AND input.status='complete'
    WHERE e.branch_id=$3 AND e.type IN ('action.started','action.completed','action.failed')
  ), starts AS (
    SELECT (event->>'invocationId')::uuid AS invocation_id,min(at) AS started_at FROM visible_events
    WHERE type='action.started' GROUP BY (event->>'invocationId')::uuid
  ), selected AS (
    SELECT * FROM starts WHERE $4::timestamptz IS NULL OR (started_at,invocation_id)<($4::timestamptz,$5::uuid)
    ORDER BY started_at DESC,invocation_id DESC LIMIT $6
  ) SELECT selected.invocation_id,selected.started_at,
    (SELECT jsonb_agg(event ORDER BY seq) FROM visible_events WHERE (event->>'invocationId')::uuid=selected.invocation_id) AS events
    FROM selected ORDER BY started_at DESC,invocation_id DESC`,
  [conversation.id, actor.id, conversation.activeBranchId, cursor?.at ?? null, cursor?.invocationId ?? null, limit + 1])).rows;
  const retained = groups.slice(0, limit);
  const items = retained.flatMap((group) => z.array(ActionEventSchema).parse(group.events))
    .sort((left, right) => left.at.localeCompare(right.at) || left.runId.localeCompare(right.runId) || left.seq - right.seq);
  const oldest = retained.at(-1);
  return ConversationActionPageSchema.parse({ conversationId: conversation.id, branchId: conversation.activeBranchId, items,
    nextCursor: groups.length > limit && oldest ? Buffer.from(JSON.stringify({ branchId: conversation.activeBranchId,
      at: iso(oldest.started_at), invocationId: oldest.invocation_id })).toString("base64url") : null });
}

async function readArtifacts(tx: DbTransaction, actor: Actor, conversationId: string): Promise<CourseArtifactRef[]> {
  const result = await tx.query<ArtifactRow>(
    `SELECT c.id AS course_id, c.title, c.summary, c.content_language, c.revision, c.current_ready_version_id AS ready_version_id,
      greatest(c.updated_at, d.updated_at) AS updated_at, d.document, d.approval_requested_revision,
      a.id AS approval_id, a.draft_id, a.draft_revision, a.content_digest, a.approved_by, a.approved_at
     FROM unfurl.conversation_artifacts ref JOIN unfurl.courses c ON c.id = ref.course_id AND c.owner_id = $2
     LEFT JOIN unfurl.curriculum_drafts d ON d.course_id = c.id AND d.conversation_id = $1
     LEFT JOIN LATERAL (SELECT approval.* FROM unfurl.curriculum_approvals approval
       WHERE approval.draft_id = d.id AND approval.draft_revision = d.revision AND approval.approved_by = $2
       ORDER BY approval.approved_at DESC LIMIT 1) a ON true
     WHERE ref.conversation_id = $1 ORDER BY ref.created_at, c.id`,
    [conversationId, actor.id],
  );
  return result.rows.map((row) => CourseArtifactRefSchema.parse({
    courseId: row.course_id, title: row.title, summary: row.summary, contentLanguage: row.content_language,
    revision: row.revision, curriculum: row.document ?? null, approval: row.approval_id ? CurriculumApprovalSchema.parse({
      id: row.approval_id, draftId: row.draft_id, draftRevision: row.draft_revision, contentDigest: row.content_digest,
      approvedBy: row.approved_by, approvedAt: iso(row.approved_at!),
    }) : null, approvalRequestedRevision: row.approval_requested_revision, readyVersionId: row.ready_version_id, updatedAt: iso(row.updated_at),
  }));
}

export async function readActiveTurn(tx: DbTransaction, actor: Actor, conversation: Conversation): Promise<AgentTurnRun | null> {
  const result = await tx.query<TurnRow>(
    `SELECT id, owner_id, conversation_id, branch_id, input_message_id, status, last_seq, error, created_at, updated_at
     FROM unfurl.agent_turn_runs WHERE conversation_id = $1 AND branch_id = $2 AND owner_id = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [conversation.id, conversation.activeBranchId, actor.id],
  );
  return result.rows[0] ? turnFromRow(result.rows[0]) : null;
}

export async function readDetail(tx: DbTransaction, actor: Actor, conversation: Conversation): Promise<ConversationDetail> {
  const composerDraft = await readComposer(tx, conversation.id);
  const messages = await readMessages(tx, conversation);
  const activeTurn = await readActiveTurn(tx, actor, conversation);
  const artifacts = await readArtifacts(tx, actor, conversation.id);
  const actionHistory = await readActionHistory(tx, actor, conversation);
  return ConversationDetailSchema.parse({ conversation, messages, activeTurn, artifacts,
    retainedActionEvents: actionHistory.items, actionHistoryNextCursor: actionHistory.nextCursor,
    composerDraft: { ...composerDraft, pendingMessages: unacceptedIntents(composerDraft.pendingMessages, messages) } });
}

export async function insertConversation(tx: DbTransaction, actor: Actor, input: { id: string; branchId: string; title: string; text: string; pendingMessages: PendingUserMessage[] }): Promise<ConversationDetail> {
  const result = await tx.query<ConversationRow>(
    `INSERT INTO unfurl.conversations (id, owner_id, title, active_branch_id) VALUES ($1, $2, $3, $4) RETURNING ${conversationColumns}`,
    [input.id, actor.id, input.title, input.branchId],
  );
  await tx.query("INSERT INTO unfurl.conversation_branches (id, conversation_id) VALUES ($1, $2)", [input.branchId, input.id]);
  const composer = await tx.query<ComposerRow>(
    "INSERT INTO unfurl.composer_drafts (conversation_id, text, pending_messages) VALUES ($1, $2, $3::jsonb) RETURNING conversation_id, text, pending_messages, revision, updated_at",
    [input.id, input.text, JSON.stringify(input.pendingMessages)],
  );
  if (!result.rows[0] || !composer.rows[0]) throw unavailable("chat.unavailable");
  return ConversationDetailSchema.parse({ conversation: conversationFromRow(result.rows[0]), composerDraft: composerFromRow(composer.rows[0]), messages: [], activeTurn: null, artifacts: [], retainedActionEvents: [], actionHistoryNextCursor: null });
}

export async function renameConversation(tx: DbTransaction, actor: Actor, id: string, expectedRevision: number, title: string): Promise<Conversation> {
  const result = await tx.query<ConversationRow>(
    `UPDATE unfurl.conversations SET title = $4, revision = revision + 1, updated_at = now()
     WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND revision = $3 RETURNING ${conversationColumns}`,
    [id, actor.id, expectedRevision, title],
  );
  if (!result.rows[0]) throw revisionConflict((await requireConversation(tx, actor, id, "update")).revision);
  return conversationFromRow(result.rows[0]);
}

export async function saveComposer(tx: DbTransaction, actor: Actor, conversation: Conversation, input: SaveComposerInput): Promise<ComposerDraft> {
  const accepted = await readMessages(tx, conversation);
  for (const intent of input.pendingMessages) {
    const existing = accepted.find((message) => message.id === intent.messageId || message.clientRequestId === intent.requestId);
    if (existing && (existing.id !== intent.messageId || existing.clientRequestId !== intent.requestId
      || existing.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") !== intent.text)) {
      throw new ServiceFault(409, "idempotency_conflict", "chat.messageIdentityChanged");
    }
  }
  const pending = unacceptedIntents(input.pendingMessages, accepted);
  const result = await tx.query<ComposerRow>(
    `UPDATE unfurl.composer_drafts SET text = $3, pending_messages = $4::jsonb, revision = revision + 1, updated_at = now()
     WHERE conversation_id = $1 AND revision = $2 RETURNING conversation_id, text, pending_messages, revision, updated_at`,
    [conversation.id, input.expectedRevision, input.text, JSON.stringify(pending)],
  );
  if (!result.rows[0]) throw revisionConflict((await readComposer(tx, conversation.id)).revision);
  await tx.query("UPDATE unfurl.conversations SET updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL", [conversation.id, actor.id]);
  return composerFromRow(result.rows[0]);
}

export async function insertUserMessage(tx: DbTransaction, conversation: Conversation, input: { messageId: string; requestId: string; parentMessageId: string | null; text: string }): Promise<ChatMessage> {
  const result = await tx.query<MessageRow>(
    `INSERT INTO unfurl.messages (id, conversation_id, branch_id, parent_message_id, role, status, parts, client_request_id)
     VALUES ($1, $2, $3, $4, 'user', 'complete', $5::jsonb, $6) RETURNING ${messageColumns}`,
    [input.messageId, conversation.id, conversation.activeBranchId, input.parentMessageId, JSON.stringify([{ type: "text", text: input.text }]), input.requestId],
  );
  if (!result.rows[0]) throw unavailable("chat.unavailable");
  return messageFromRow(result.rows[0]);
}

export async function touchConversation(tx: DbTransaction, actor: Actor, conversation: Conversation): Promise<Conversation> {
  const result = await tx.query<ConversationRow>(
    `UPDATE unfurl.conversations SET revision = revision + 1, updated_at = now()
     WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND revision = $3 RETURNING ${conversationColumns}`,
    [conversation.id, actor.id, conversation.revision],
  );
  if (!result.rows[0]) throw revisionConflict(conversation.revision);
  return conversationFromRow(result.rows[0]);
}

export async function hasActiveRuns(tx: DbTransaction, actor: Actor, conversationId: string): Promise<boolean> {
  const result = await tx.query<{ active: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM unfurl.agent_turn_runs WHERE conversation_id = $1 AND owner_id = $2 AND status IN ('queued', 'running', 'awaiting_user')
     UNION ALL SELECT 1 FROM unfurl.generation_runs WHERE conversation_id = $1 AND owner_id = $2 AND status IN ('queued', 'running', 'awaiting_user')) AS active`,
    [conversationId, actor.id],
  );
  return result.rows[0]?.active ?? false;
}

export async function deleteConversation(tx: DbTransaction, actor: Actor, conversation: Conversation): Promise<void> {
  const result = await tx.query(
    "UPDATE unfurl.conversations SET deleted_at = now(), updated_at = now(), revision = revision + 1 WHERE id = $1 AND owner_id = $2 AND revision = $3 AND deleted_at IS NULL RETURNING id",
    [conversation.id, actor.id, conversation.revision],
  );
  if (!result.rows.length) throw revisionConflict(conversation.revision);
  await tx.query("UPDATE unfurl.local_imports SET deleted_at = now() WHERE actor_id = $1 AND conversation_id = $2 AND deleted_at IS NULL", [actor.id, conversation.id]);
}
