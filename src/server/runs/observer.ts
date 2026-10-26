import "server-only";
import { CurriculumDraftSchema } from "../../domain/course";
import { ChatEventSchema, RunSnapshotSchema } from "../../domain/generation";
import { GenerationEventSchema, GenerationHistoryPageSchema, GenerationSnapshotSchema, GenerationTimelineEventSchema, type GenerationSnapshot } from "../../domain/generation-observer";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import { readDetail, requireConversation } from "../conversations/repository";
import { generationFromRow, turnFromRow, type GenerationRow } from "../curricula/repository";
import type { DbTransaction } from "../db";
import { readGenerationProgress } from "./generation-progress";

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
  const snapshots = await readGenerationSnapshots(tx, actor, [id]);
  if (snapshots.length !== 1) throw missing();
  return snapshots[0]!;
}

const timelineTypes = ["generation.commentary", "generation.action.started", "generation.action.completed"];
interface SnapshotRow extends GenerationRow { document: unknown; content_digest: string; completed: unknown[]; validation: unknown | null;
  timeline: unknown[]; ready_course: unknown | null }

/** One evidence query hydrates every retry; only currently active work needs live lease/progress reads. */
export async function readGenerationSnapshots(tx: DbTransaction, actor: Actor, ids: readonly string[]): Promise<GenerationSnapshot[]> {
  if (!ids.length) return [];
  const rows = (await tx.query<SnapshotRow>(`SELECT r.*,revision.document,a.content_digest,
      COALESCE((SELECT jsonb_agg(done.event ORDER BY done.seq) FROM (
        SELECT DISTINCT ON (event->>'moduleId') event,seq FROM unfurl.generation_events
        WHERE run_id=r.id AND branch_id=r.branch_id AND seq<=r.last_seq AND type='generation.module.completed'
        ORDER BY event->>'moduleId',seq DESC) done),'[]'::jsonb) AS completed,
      (SELECT event FROM unfurl.generation_events WHERE run_id=r.id AND branch_id=r.branch_id
        AND seq<=r.last_seq AND type='generation.validation.summary' ORDER BY seq DESC LIMIT 1) AS validation,
      COALESCE((SELECT jsonb_agg(history.event ORDER BY history.seq DESC) FROM (
        SELECT event,seq FROM unfurl.generation_events WHERE run_id=r.id AND branch_id=r.branch_id
          AND seq<=r.last_seq AND type=ANY($3::text[]) ORDER BY seq DESC
          LIMIT CASE WHEN r.status IN ('queued','running') THEN 101 ELSE 21 END) history),'[]'::jsonb) AS timeline,
      (SELECT jsonb_build_object('courseId',v.course_id,'courseVersionId',v.id,'title',v.title,'summary',v.summary,
        'contentLanguage',v.content_language,'moduleCount',jsonb_array_length(v.modules),'lessonCount',cardinality(v.lesson_ids))
        FROM unfurl.course_versions v JOIN unfurl.version_validation_receipts receipt ON receipt.id=v.validation_receipt_id
          AND receipt.course_version_id=v.id AND receipt.verdict='passed'
        WHERE v.id=r.output_version_id AND v.course_id=r.course_id AND v.source_run_id=r.id AND v.approval_id=r.approval_id
          AND v.content_digest=a.content_digest AND v.state='ready' AND r.status='succeeded') AS ready_course
    FROM unfurl.generation_runs r JOIN unfurl.conversations conversation
      ON conversation.id=r.conversation_id AND conversation.owner_id=r.owner_id AND conversation.deleted_at IS NULL
    JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id AND a.draft_revision=r.source_draft_revision
    JOIN unfurl.curriculum_revisions revision ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
    JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id AND d.course_id=r.course_id AND d.conversation_id=r.conversation_id
    JOIN unfurl.courses c ON c.id=r.course_id AND c.owner_id=r.owner_id
    WHERE r.id=ANY($1::uuid[]) AND r.owner_id=$2 ORDER BY r.created_at,r.id`, [ids, actor.id, timelineTypes])).rows;
  const snapshots: GenerationSnapshot[] = [];
  for (const row of rows) {
    if (!ids.includes(row.id) || row.owner_id !== actor.id) throw missing();
    snapshots.push(await projectGenerationSnapshot(tx, row));
  }
  return snapshots;
}

async function projectGenerationSnapshot(tx: DbTransaction, row: SnapshotRow): Promise<GenerationSnapshot> {
  const run = generationFromRow(row), draft = CurriculumDraftSchema.parse(row.document);
  if (draft.courseId !== run.courseId || draft.conversationId !== run.conversationId || draft.revision !== run.sourceDraftRevision) throw missing();
  const completed = row.completed.map(item => GenerationEventSchema.parse(item));
  const sameBuild = (event: ReturnType<typeof GenerationEventSchema.parse>) => event.runId === run.id
    && event.courseId === run.courseId && event.branchId === run.branchId;
  const lastValidation = row.validation ? GenerationEventSchema.parse(row.validation) : null;
  const modules = draft.modules.map(module => {
    const event = completed.find(item => sameBuild(item) && item.type === "generation.module.completed" && item.moduleId === module.id);
    return { moduleId: module.id, title: module.title, status: event ? "complete" : "pending",
      completedTasks: event?.type === "generation.module.completed" ? event.completedTasks : 0 };
  });
  const progress = await readGenerationProgress(tx, run, row.content_digest, modules.map(module => module.moduleId),
    new Set(modules.filter(module => module.status === "complete").map(module => module.moduleId)));
  if (progress?.activity === "running" && progress.moduleId) {
    const current = modules.find(module => module.moduleId === progress.moduleId)!;
    if (current.status !== "complete" && progress.stage !== "preparing") current.status = ["researching", "reading_sources"].includes(progress.stage)
      ? "researching" : ["validating_practice", "reviewing_section", "saving_section"].includes(progress.stage) ? "validating" : "building";
  }
  const limit = ["queued", "running"].includes(run.status) ? 100 : 20;
  const timeline = row.timeline.map(item => GenerationTimelineEventSchema.parse(item));
  const retained = timeline.slice(0, limit).sort((left, right) => left.seq - right.seq);
  if (run.status === "succeeded" && !row.ready_course) throw missing();
  return GenerationSnapshotSchema.parse({ run, approvedDraftRevision: draft.revision, approvalDigest: row.content_digest,
    modules, work: { completed: modules.filter(module => module.status === "complete").length, total: modules.length || null },
    validation: lastValidation?.type === "generation.validation.summary" && sameBuild(lastValidation) ? lastValidation.summary : null,
    ...(progress ? { progress } : {}),
    readyVersionId: run.outputVersionId, lastSeq: run.lastSeq, retainedTimelineEvents: retained,
    timelineBeforeSeq: timeline.length > limit ? retained[0]!.seq : null, readyCourse: row.ready_course });
}

export async function readGenerationHistory(tx: DbTransaction, actor: Actor, id: string, query: { before?: number; limit?: number } = {}) {
  const row = await requireObservedRun(tx, actor, id, "generation"), run = generationFromRow(row);
  if (!run.courseId || !run.approvalId) throw missing();
  const limit = query.limit ?? 50;
  const rows = (await tx.query<{ event: unknown }>(`SELECT event FROM unfurl.generation_events
    WHERE run_id=$1 AND branch_id=$2 AND seq<=$3 AND ($4::integer IS NULL OR seq<$4) AND type=ANY($5::text[])
    ORDER BY seq DESC LIMIT $6`, [id, run.branchId, run.lastSeq, query.before ?? null, timelineTypes, limit + 1])).rows;
  const items = rows.slice(0, limit).map(item => GenerationTimelineEventSchema.parse(item.event)).sort((a, b) => a.seq - b.seq);
  return GenerationHistoryPageSchema.parse({ runId: id, courseId: run.courseId, branchId: run.branchId, items,
    beforeSeq: rows.length > limit ? items[0]!.seq : null });
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
