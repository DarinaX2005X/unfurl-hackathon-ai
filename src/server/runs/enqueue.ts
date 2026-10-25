import "server-only";
import { randomUUID } from "node:crypto";
import { IdSchema } from "../../domain/common";
import { ChatEventSchema } from "../../domain/generation";
import { GenerationEventSchema } from "../../domain/generation-observer";
import type { DbTransaction } from "../db";
import { ServiceFault, unavailable } from "../auth/errors";

interface EnqueueRunRow { id: string; owner_id: string; conversation_id: string; branch_id: string; status: string; last_seq: number; course_id?: string }

/** Caller has already checked real runtime admission. This producer performs no external I/O. */
export async function enqueueAcceptedRun(tx: DbTransaction, input: { kind: "agent_turn" | "generation"; runId: string }): Promise<{ jobId: string }> {
  IdSchema.parse(input.runId);
  const generation = input.kind === "generation";
  const table = generation ? "generation_runs" : "agent_turn_runs";
  const foreignKey = generation ? "generation_run_id" : "agent_turn_run_id";
  const run = (await tx.query<EnqueueRunRow>(`SELECT r.* FROM unfurl.${table} r
    JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id AND c.deleted_at IS NULL
    WHERE r.id=$1 ${generation ? "" : "AND c.active_branch_id=r.branch_id"} FOR UPDATE OF r`, [input.runId])).rows[0];
  if (!run) throw unavailable("generation.acceptanceUnconfirmed");
  const existing = (await tx.query<{ id: string }>(`SELECT id FROM unfurl.execution_jobs WHERE ${foreignKey}=$1`, [run.id])).rows[0];
  if (existing) return { jobId: existing.id };
  if (run.status !== "queued" || run.last_seq !== 0) throw unavailable("generation.acceptanceUnconfirmed");
  if (generation) {
    const binding = (await tx.query<{ id: string }>(`SELECT v.id FROM unfurl.course_versions v
      JOIN unfurl.generation_runs r ON r.id=v.source_run_id AND r.approval_id=v.approval_id AND r.course_id=v.course_id
      JOIN unfurl.courses c ON c.id=r.course_id AND c.owner_id=r.owner_id
      JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id AND a.approved_by=r.owner_id AND a.draft_revision=r.source_draft_revision AND a.content_digest=v.content_digest
      JOIN unfurl.curriculum_drafts d ON d.id=a.draft_id AND d.course_id=r.course_id AND d.revision=a.draft_revision
      WHERE r.id=$1 AND v.state IN ('building','validating')`, [run.id])).rows[0];
    if (!binding || !run.course_id) throw unavailable("generation.approvalUnavailable");
  }
  const jobId = randomUUID();
  await tx.query(`INSERT INTO unfurl.execution_jobs (id,${foreignKey}) VALUES ($1,$2)`, [jobId, run.id]);
  const identity = { id: randomUUID(), runId: run.id, branchId: run.branch_id, seq: 1, at: new Date().toISOString() };
  const event = generation
    ? GenerationEventSchema.parse({ ...identity, courseId: run.course_id, type: "generation.accepted", status: "queued" })
    : ChatEventSchema.parse({ ...identity, type: "run.accepted", status: "queued" });
  await tx.query(`INSERT INTO unfurl.${generation ? "generation_events" : "agent_turn_events"} (id,run_id,branch_id,seq,type,event,at)
    VALUES ($1,$2,$3,1,$4,$5,$6)`, [event.id, run.id, run.branch_id, event.type, JSON.stringify(event), event.at]);
  await tx.query(`UPDATE unfurl.${table} SET last_seq=1,updated_at=now() WHERE id=$1`, [run.id]);
  await tx.query("INSERT INTO unfurl.outbox (id,job_id,operation) VALUES ($1,$2,'start')", [randomUUID(), jobId]);
  return { jobId };
}

/** Persists cancellation/fence invalidation before the dispatcher asks the SDK to stop. Never refunds paid reservations. */
export async function cancelGenerationInTransaction(tx: DbTransaction, input: {
  runId: string; ownerId: string; reason: "user" | "superseded";
}): Promise<{ cancelled: boolean }> {
  IdSchema.parse(input.runId); IdSchema.parse(input.ownerId);
  const run = (await tx.query<EnqueueRunRow>(`SELECT r.* FROM unfurl.generation_runs r
    JOIN unfurl.courses c ON c.id=r.course_id AND c.owner_id=$2
    WHERE r.id=$1 AND r.owner_id=$2 FOR UPDATE OF r`, [input.runId, input.ownerId])).rows[0];
  if (!run || !run.course_id) throw new ServiceFault(404, "not_found", "generation.notFound");
  if (["succeeded", "failed", "cancelled"].includes(run.status)) return { cancelled: false };
  const event = GenerationEventSchema.parse({ id: randomUUID(), runId: run.id, courseId: run.course_id,
    branchId: run.branch_id, seq: run.last_seq + 1, at: new Date().toISOString(), type: "generation.cancelled", reason: input.reason });
  await tx.query("UPDATE unfurl.generation_runs SET status='cancelled',error=NULL,last_seq=$2,updated_at=now() WHERE id=$1", [run.id, event.seq]);
  await tx.query(`INSERT INTO unfurl.generation_events (id,run_id,branch_id,seq,type,event,at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [event.id, run.id, run.branch_id, event.seq, event.type, JSON.stringify(event), event.at]);
  await tx.query("UPDATE unfurl.course_versions SET state='failed' WHERE source_run_id=$1 AND state IN ('building','validating')", [run.id]);
  const job = (await tx.query<{ id: string }>(`UPDATE unfurl.execution_jobs SET status='cancelled',fencing_token=fencing_token+1,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE generation_run_id=$1 RETURNING id`, [run.id])).rows[0];
  if (job) {
    await tx.query(`UPDATE unfurl.run_steps SET status='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=now() WHERE job_id=$1 AND status IN ('pending','running')`, [job.id]);
    await tx.query("INSERT INTO unfurl.outbox (id,job_id,operation) VALUES ($1,$2,'cancel') ON CONFLICT (job_id,operation) DO NOTHING", [randomUUID(), job.id]);
  }
  return { cancelled: true };
}
