import "server-only";
import { ConversationBuildSchema, type ConversationBuild } from "../../domain/conversations";
import { CurriculumDraftSchema } from "../../domain/course";
import type { Conversation } from "../../domain/generation";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";

interface BuildRow { id: string; retry_of_run_id: string | null; approval_id: string; draft_id: string;
  draft_revision: number; content_digest: string; approved_at: Date | string; course_id: string;
  branch_id: string; owner_id: string; conversation_id: string; document: unknown; summary: string }

/** Approval receipts survive draft edits; all retry rows remain under that immutable receipt. */
export async function readConversationBuilds(tx: DbTransaction, actor: Actor, conversation: Conversation): Promise<ConversationBuild[]> {
  const rows = (await tx.query<BuildRow>(`SELECT r.id,r.retry_of_run_id,r.approval_id,a.draft_id,a.draft_revision,a.content_digest,a.approved_at,
      r.course_id,r.branch_id,r.owner_id,r.conversation_id,revision.document,v.summary
    FROM unfurl.generation_runs r JOIN unfurl.conversations conversation
      ON conversation.id=r.conversation_id AND conversation.owner_id=r.owner_id AND conversation.deleted_at IS NULL
    JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id AND a.draft_revision=r.source_draft_revision
    JOIN unfurl.curriculum_revisions revision ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
    JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id AND d.course_id=r.course_id AND d.conversation_id=r.conversation_id
    JOIN unfurl.courses c ON c.id=r.course_id AND c.owner_id=r.owner_id
    JOIN unfurl.conversation_artifacts artifact ON artifact.course_id=r.course_id AND artifact.conversation_id=r.conversation_id
    JOIN unfurl.course_versions v ON v.course_id=r.course_id AND v.approval_id=r.approval_id AND v.content_digest=a.content_digest
    WHERE r.conversation_id=$1 AND r.owner_id=$2 AND r.branch_id=$3
    ORDER BY a.approved_at,a.id,r.created_at,r.id`, [conversation.id, actor.id, conversation.activeBranchId])).rows;
  if (!rows.length) return [];
  // Dynamic import avoids a module-initialization cycle with the ordinary chat snapshot reader.
  const { readGenerationSnapshots } = await import("../runs/observer");
  const snapshots = new Map((await readGenerationSnapshots(tx, actor, rows.map(row => row.id))).map(snapshot => [snapshot.run.id, snapshot]));
  const builds = new Map<string, ConversationBuild>();
  for (const row of rows) {
    const snapshot = snapshots.get(row.id), draft = CurriculumDraftSchema.parse(row.document);
    if (!snapshot || row.owner_id !== actor.id || row.conversation_id !== conversation.id || row.branch_id !== conversation.activeBranchId
      || draft.id !== row.draft_id || draft.courseId !== row.course_id || draft.conversationId !== conversation.id || draft.revision !== row.draft_revision)
      throw new ServiceFault(404, "not_found", "generation.notFound");
    let build = builds.get(row.approval_id);
    if (!build) {
      build = { approvalId: row.approval_id, draftId: row.draft_id, draftRevision: row.draft_revision, approvalDigest: row.content_digest,
        approvedAt: new Date(row.approved_at).toISOString(), courseId: row.course_id, branchId: row.branch_id,
        title: draft.title, summary: row.summary, contentLanguage: draft.contentLanguage, initialRunId: row.id, runs: [] };
      builds.set(row.approval_id, build);
    }
    build.runs.push({ retryOfRunId: row.retry_of_run_id, snapshot });
  }
  // Follow explicit ancestry rather than equal-time UUID ordering.
  return [...builds.values()].map(build => {
    const pending = [...build.runs], ordered: ConversationBuild["runs"] = [];
    let predecessor: string | null = null;
    while (pending.length) {
      const matches = pending.filter(entry => entry.retryOfRunId === predecessor);
      if (matches.length !== 1) throw new ServiceFault(404, "not_found", "generation.notFound");
      const next = matches[0]!;
      ordered.push(next); pending.splice(pending.indexOf(next), 1); predecessor = next.snapshot.run.id;
    }
    return ConversationBuildSchema.parse({ ...build, initialRunId: ordered[0]!.snapshot.run.id, runs: ordered });
  });
}
