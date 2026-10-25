import "server-only";
import { CurriculumDraftSchema } from "../../domain/course";
import { ChatEventSchema, RunSnapshotSchema } from "../../domain/generation";
import { GenerationEventSchema, GenerationSnapshotSchema } from "../../domain/generation-observer";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import { readDetail, requireConversation } from "../conversations/repository";
import { generationFromRow, turnFromRow, type GenerationRow } from "../curricula/repository";
import type { DbTransaction } from "../db";

export type ObservedRunKind = "agent_turn" | "generation";
const missing = () => new ServiceFault(404, "not_found", "generation.notFound");
export async function requireObservedRun(tx: DbTransaction, actor: Actor, id: string, kind: ObservedRunKind, lock = false) {
  const table = kind === "generation" ? "generation_runs" : "agent_turn_runs";
  const row = (await tx.query<GenerationRow>(`SELECT r.* FROM unfurl.${table} r JOIN unfurl.conversations c
    ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.deleted_at IS NULL
    WHERE r.id=$1 AND r.owner_id=$2 ${lock ? "FOR UPDATE OF r" : "FOR SHARE OF r"}`, [id, actor.id])).rows[0];
  if (!row) throw missing();
  return row;
}
export async function readRunSnapshot(tx: DbTransaction, actor: Actor, id: string, kind: ObservedRunKind) {
  const row = await requireObservedRun(tx, actor, id, kind);
  if (kind === "agent_turn") {
    const run = turnFromRow(row);
    const conversation = await requireConversation(tx, actor, run.conversationId);
    const detail = await readDetail(tx, actor, { ...conversation, activeBranchId: run.branchId });
    const events = (await tx.query<{ event: unknown }>(`SELECT event FROM unfurl.agent_turn_events
      WHERE run_id=$1 AND seq<=$2 AND type IN ('action.started','action.completed','action.failed') ORDER BY seq`, [id, row.last_seq])).rows;
    return RunSnapshotSchema.parse({ run, messages: detail.messages, artifacts: detail.artifacts,
      lastSeq: run.lastSeq, retainedActionEvents: events.map(item => ChatEventSchema.parse(item.event)) });
  }
  const run = generationFromRow(row);
  const approved = (await tx.query<{ document: unknown; content_digest: string }>(`SELECT revision.document,a.content_digest
    FROM unfurl.curriculum_approvals a JOIN unfurl.curriculum_revisions revision
    ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
    JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id JOIN unfurl.courses c ON c.id=d.course_id
    WHERE a.id=$1 AND a.approved_by=$2 AND c.owner_id=$2 AND c.id=$3 AND a.draft_revision=$4`,
  [run.approvalId, actor.id, run.courseId, run.sourceDraftRevision])).rows[0];
  if (!approved) throw missing();
  const draft = CurriculumDraftSchema.parse(approved.document);
  const completed = (await tx.query<{ event: unknown }>(`SELECT DISTINCT ON (event->>'moduleId') event FROM unfurl.generation_events
    WHERE run_id=$1 AND seq<=$2 AND type='generation.module.completed' ORDER BY event->>'moduleId',seq DESC`, [id, run.lastSeq])).rows.map(item => GenerationEventSchema.parse(item.event));
  const validation = (await tx.query<{ event: unknown }>(`SELECT event FROM unfurl.generation_events
    WHERE run_id=$1 AND seq<=$2 AND type='generation.validation.summary' ORDER BY seq DESC LIMIT 1`, [id, run.lastSeq])).rows[0];
  const lastValidation = validation ? GenerationEventSchema.parse(validation.event) : null;
  const modules = draft.modules.map(module => {
    const event = completed.find(item => item.type === "generation.module.completed" && item.moduleId === module.id);
    return { moduleId: module.id, title: module.title, status: event ? "complete" : "pending",
      completedTasks: event?.type === "generation.module.completed" ? event.completedTasks : 0 };
  });
  return GenerationSnapshotSchema.parse({ run, approvedDraftRevision: draft.revision, approvalDigest: approved.content_digest,
    modules, work: { completed: modules.filter(module => module.status === "complete").length, total: modules.length || null },
    validation: lastValidation?.type === "generation.validation.summary" ? lastValidation.summary : null,
    readyVersionId: run.outputVersionId, lastSeq: run.lastSeq });
}

export async function readRunEvents(tx: DbTransaction, actor: Actor, id: string, kind: ObservedRunKind, after: number) {
  const run = await requireObservedRun(tx, actor, id, kind);
  if (after > run.last_seq) return { events: [], snapshotRequired: true, terminal: false };
  const table = kind === "generation" ? "generation_events" : "agent_turn_events";
  const rows = (await tx.query<{ event: unknown }>(`SELECT event FROM unfurl.${table} WHERE run_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT 100`, [id, after, run.last_seq])).rows;
  const events = rows.map(row => kind === "generation" ? GenerationEventSchema.parse(row.event) : ChatEventSchema.parse(row.event));
  const snapshotRequired = (events.length === 0 && after < run.last_seq) || events.some((event, index) => event.seq !== after + index + 1);
  return { events: snapshotRequired ? [] : events, snapshotRequired,
    terminal: ["succeeded", "failed", "cancelled", "awaiting_user"].includes(run.status) && (events.at(-1)?.seq ?? after) === run.last_seq };
}
