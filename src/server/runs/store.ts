import "server-only";
import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../db";
import { withSystemTransaction } from "../db";
import { ProviderFailure } from "../ai/failure";
import { jsonDigest } from "../ai/json";
import type { ExecutionTarget, JobClaim, RunHandler } from "./ports";
import type { RunHandlerRegistry } from "./registry";

export const JOB_LEASE_SECONDS = 120;
export interface JobRow { id: string; agent_turn_run_id: string | null; generation_run_id: string | null;
  evaluation_id: string | null; target_evaluation_revision: number | null; activity_action_id: string | null;
  status: string; lease_owner: string | null; fencing_token: string; retry_epoch: number; live: boolean }
export type RuntimeTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
export const runtimeTransaction: RuntimeTransaction = work => withSystemTransaction("run_execution", work);
const lost = () => new ProviderFailure("cancelled");

export async function resolveTarget(tx: DbTransaction, row: JobRow): Promise<ExecutionTarget> {
  if (row.agent_turn_run_id) {
    const run = (await tx.query<{ id: string; owner_id: string; conversation_id: string; branch_id: string; input_message_id: string }>(`SELECT r.* FROM unfurl.agent_turn_runs r
      JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.active_branch_id=r.branch_id AND c.deleted_at IS NULL
      WHERE r.id=$1 AND r.status IN ('queued','running') FOR UPDATE OF r`, [row.agent_turn_run_id])).rows[0];
    if (!run) throw lost();
    return { kind: "agent_turn", runId: run.id, ownerId: run.owner_id, conversationId: run.conversation_id, branchId: run.branch_id, inputMessageId: run.input_message_id };
  }
  if (row.generation_run_id) {
    const scope = (await tx.query<{ course_id: string; draft_id: string }>(`SELECT r.course_id,a.draft_id FROM unfurl.generation_runs r
      JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id WHERE r.id=$1`, [row.generation_run_id])).rows[0];
    if (!scope) throw lost();
    await tx.query("SELECT id FROM unfurl.courses WHERE id=$1 FOR UPDATE", [scope.course_id]);
    await tx.query("SELECT id FROM unfurl.curriculum_drafts WHERE id=$1 FOR UPDATE", [scope.draft_id]);
    const run = (await tx.query<{ id: string; owner_id: string; conversation_id: string; branch_id: string; input_message_id: string;
      course_id: string; approval_id: string; approval_digest: string; version_id: string }>(`SELECT r.*,a.content_digest AS approval_digest,v.id AS version_id
      FROM unfurl.generation_runs r JOIN unfurl.conversations conversation ON conversation.id=r.conversation_id AND conversation.owner_id=r.owner_id AND conversation.deleted_at IS NULL
      JOIN unfurl.courses course ON course.id=r.course_id AND course.owner_id=r.owner_id
      JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id AND a.draft_revision=r.source_draft_revision
      JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id AND d.course_id=r.course_id AND d.revision=a.draft_revision
      JOIN unfurl.curriculum_revisions revision ON revision.draft_id=a.draft_id AND revision.revision=a.draft_revision AND revision.content_digest=a.content_digest
      JOIN unfurl.course_versions v ON v.source_run_id=r.id AND v.course_id=r.course_id AND v.approval_id=a.id AND v.content_digest=a.content_digest
      WHERE r.id=$1 AND r.status IN ('queued','running') AND v.state IN ('building','validating') FOR UPDATE OF r`, [row.generation_run_id])).rows[0];
    if (!run) throw lost();
    return { kind: "generation", runId: run.id, ownerId: run.owner_id, conversationId: run.conversation_id, branchId: run.branch_id,
      inputMessageId: run.input_message_id, courseId: run.course_id, approvalId: run.approval_id, approvalDigest: run.approval_digest, courseVersionId: run.version_id };
  }
  if (row.evaluation_id && row.target_evaluation_revision) return { kind: "evaluation", evaluationId: row.evaluation_id, targetEvaluationRevision: row.target_evaluation_revision };
  if (row.activity_action_id) return { kind: "activity_action", activityActionId: row.activity_action_id };
  throw lost();
}
async function job(tx: DbTransaction, jobId: string, lock = false) {
  return (await tx.query<JobRow>(`SELECT *,fencing_token::text,lease_expires_at>now() AS live FROM unfurl.execution_jobs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [jobId])).rows[0];
}
export async function guardClaim(tx: DbTransaction, claim: JobClaim, handler: RunHandler): Promise<void> {
  const before = await job(tx, claim.jobId);
  if (!before) throw lost();
  const target = await resolveTarget(tx, before);
  await handler.assertAuthority(tx, target);
  const current = await job(tx, claim.jobId, true);
  if (!current || current.status !== "running" || !current.live || current.lease_owner !== claim.leaseOwner ||
    current.fencing_token !== claim.fencingToken || current.retry_epoch !== claim.retryEpoch || jsonDigest(target) !== jsonDigest(claim.target)) throw lost();
}
export async function claimJob(tx: DbTransaction, jobId: string, registry: RunHandlerRegistry): Promise<{ kind: "claimed"; claim: JobClaim } | { kind: "busy" | "finished" }> {
  const before = await job(tx, jobId);
  if (!before || !["queued", "running"].includes(before.status)) return { kind: "finished" };
  if (before.status === "running" && before.live) return { kind: "busy" };
  const target = await resolveTarget(tx, before);
  const handler = registry.require(target.kind);
  await handler.assertAuthority(tx, target);
  const current = await job(tx, jobId, true);
  if (!current || !["queued", "running"].includes(current.status)) return { kind: "finished" };
  if (current.status === "running" && current.live) return { kind: "busy" };
  const leaseOwner = randomUUID();
  const saved = (await tx.query<{ fencing_token: string; retry_epoch: number }>(`UPDATE unfurl.execution_jobs SET status='running',lease_owner=$2,
    lease_expires_at=now()+make_interval(secs=>$3),fencing_token=fencing_token+1,attempt_count=attempt_count+1,updated_at=now()
    WHERE id=$1 RETURNING fencing_token::text,retry_epoch`, [jobId, leaseOwner, JOB_LEASE_SECONDS])).rows[0]!;
  if (target.kind === "agent_turn" || target.kind === "generation") await tx.query(`UPDATE unfurl.${target.kind === "agent_turn" ? "agent_turn_runs" : "generation_runs"} SET status='running',updated_at=now() WHERE id=$1`, [target.runId]);
  return { kind: "claimed", claim: { jobId, leaseOwner, fencingToken: saved.fencing_token, retryEpoch: saved.retry_epoch, target } };
}
