import "server-only";
import { randomUUID } from "node:crypto";
import { IdSchema } from "../../domain/common";
import { ChatEventSchema } from "../../domain/generation";
import { GenerationEventSchema } from "../../domain/generation-observer";
import type { DbTransaction } from "../db";
import { ServiceFault, unavailable } from "../auth/errors";

interface EnqueueRunRow { id: string; owner_id: string; conversation_id: string; branch_id: string; status: string; last_seq: number; course_id?: string }
export async function cancelTurnInTransaction(tx:DbTransaction,input:{runId:string;ownerId:string;reason:"user"|"superseded"}):Promise<{cancelled:boolean}>{
  const run=(await tx.query<EnqueueRunRow>("SELECT * FROM unfurl.agent_turn_runs WHERE id=$1 AND owner_id=$2 FOR UPDATE",[input.runId,input.ownerId])).rows[0];
  if(!run)throw new ServiceFault(404,"not_found","generation.notFound");
  if(!["queued","running"].includes(run.status))return{cancelled:false};
  const event=ChatEventSchema.parse({id:randomUUID(),runId:run.id,branchId:run.branch_id,seq:run.last_seq+1,at:new Date().toISOString(),type:"run.cancelled",reason:input.reason});
  await tx.query("UPDATE unfurl.agent_turn_runs SET status='cancelled',last_seq=$2,error=NULL,updated_at=now() WHERE id=$1",[run.id,event.seq]);
  await tx.query("INSERT INTO unfurl.agent_turn_events(id,run_id,branch_id,seq,type,event,at) VALUES($1,$2,$3,$4,$5,$6,$7)",[event.id,run.id,event.branchId,event.seq,event.type,JSON.stringify(event),event.at]);
  const job=(await tx.query<{id:string}>("UPDATE unfurl.execution_jobs SET status='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE agent_turn_run_id=$1 RETURNING id",[run.id])).rows[0];
  if(job){
    await tx.query("UPDATE unfurl.run_steps SET status='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE job_id=$1 AND status IN ('pending','running')",[job.id]);
    await tx.query("INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'cancel') ON CONFLICT(job_id,operation) DO NOTHING",[randomUUID(),job.id]);
  }
  return{cancelled:true};
}
export type LearningJobTarget = { kind: "evaluation"; evaluationId: string; targetEvaluationRevision: number }
  | { kind: "activity_action"; activityActionId: string };

/** The learning service retains the authorized attempt/action even when dispatch is unavailable. */
export async function enqueueLearningJobTx(tx: DbTransaction, input: LearningJobTarget, options: { dispatch: boolean }): Promise<{ jobId: string }> {
  if (input.kind === "evaluation") {
    IdSchema.parse(input.evaluationId);
    if (!Number.isSafeInteger(input.targetEvaluationRevision) || input.targetEvaluationRevision < 1) throw unavailable("evaluation.unavailable");
    const evaluation = (await tx.query<{ id: string; revision: number; status: string }>("SELECT id,revision,status FROM unfurl.evaluations WHERE id=$1 FOR UPDATE", [input.evaluationId])).rows[0];
    const review = evaluation && evaluation.revision + 1 === input.targetEvaluationRevision && ["evaluated", "uncertain"].includes(evaluation.status)
      ? (await tx.query<{ id: string }>(`SELECT r.id FROM unfurl.assessment_review_requests r JOIN unfurl.evaluations e ON e.id=r.evaluation_id AND e.attempt_id=r.attempt_id
        WHERE r.evaluation_id=$1 AND r.expected_evaluation_revision=$2 AND e.revision=$2 AND r.status IN ('queued','unavailable') FOR UPDATE OF r`,
      [input.evaluationId, evaluation.revision])).rows[0] : null;
    if (!evaluation || !(evaluation.revision === input.targetEvaluationRevision && evaluation.status === "unavailable") && !review) throw new ServiceFault(409, "revision_conflict", "evaluation.changed");
    const prior = (await tx.query<{ id: string }>("SELECT id FROM unfurl.execution_jobs WHERE evaluation_id=$1 AND target_evaluation_revision=$2", [input.evaluationId, input.targetEvaluationRevision])).rows[0];
    if (prior) return { jobId: prior.id };
    const jobId = randomUUID();
    await tx.query("INSERT INTO unfurl.execution_jobs (id,evaluation_id,target_evaluation_revision,status) VALUES ($1,$2,$3,$4)", [jobId, input.evaluationId, input.targetEvaluationRevision, options.dispatch ? "queued" : "waiting"]);
    if (review) await tx.query("UPDATE unfurl.assessment_review_requests SET execution_job_id=$2,updated_at=now() WHERE id=$1", [review.id, jobId]);
    if (options.dispatch) await tx.query("INSERT INTO unfurl.outbox (id,job_id,operation) VALUES ($1,$2,'start')", [randomUUID(), jobId]);
    return { jobId };
  }
  IdSchema.parse(input.activityActionId);
  const action = (await tx.query<{ id: string; status: string }>("SELECT id,status FROM unfurl.activity_actions WHERE id=$1 FOR UPDATE", [input.activityActionId])).rows[0];
  if (!action || action.status === "completed") throw new ServiceFault(409, "revision_conflict", "activity.changed");
  const prior = (await tx.query<{ id: string }>("SELECT id FROM unfurl.execution_jobs WHERE activity_action_id=$1", [input.activityActionId])).rows[0];
  if (prior) return { jobId: prior.id };
  const jobId = randomUUID();
  await tx.query("INSERT INTO unfurl.execution_jobs (id,activity_action_id,status) VALUES ($1,$2,$3)", [jobId, input.activityActionId, options.dispatch ? "queued" : "waiting"]);
  if (options.dispatch) await tx.query("INSERT INTO unfurl.outbox (id,job_id,operation) VALUES ($1,$2,'start')", [randomUUID(), jobId]);
  return { jobId };
}

/** Initial capability activation retains epoch zero; only an explicit paid retry may advance it. */
export async function resumeLearningJobTx(tx: DbTransaction, input: LearningJobTarget, options: {
  actorId: string; expectedRetryEpoch: number; explicitPaidRetry: boolean; retryReceiptId?: string;
}): Promise<{ jobId: string; retryEpoch: number }> {
  IdSchema.parse(options.actorId);
  const owned = input.kind === "evaluation"
    ? (await tx.query(`SELECT e.id FROM unfurl.evaluations e JOIN unfurl.attempts a ON a.id=e.attempt_id WHERE e.id=$1 AND a.learner_id=$2`, [input.evaluationId,options.actorId])).rowCount === 1
    : (await tx.query(`SELECT a.id FROM unfurl.activity_actions a JOIN unfurl.activity_sessions s ON s.id=a.activity_session_id
      JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE a.id=$1 AND e.learner_id=$2`, [input.activityActionId,options.actorId])).rowCount === 1;
  if (!owned) throw new ServiceFault(404,"not_found","evaluation.notFound");
  // Domain target locks precede the job lock, matching worker authority checks.
  await enqueueLearningJobTx(tx, input, { dispatch: false });
  const key = input.kind === "evaluation" ? "evaluation_id=$1 AND target_evaluation_revision=$2" : "activity_action_id=$1";
  const values = input.kind === "evaluation" ? [input.evaluationId, input.targetEvaluationRevision] : [input.activityActionId];
  const job = (await tx.query<{ id: string; status: string; retry_epoch: number }>(`SELECT id,status,retry_epoch FROM unfurl.execution_jobs WHERE ${key} FOR UPDATE`, values)).rows[0];
  if (!job || !["waiting","failed"].includes(job.status) || job.retry_epoch !== options.expectedRetryEpoch) throw new ServiceFault(409,"revision_conflict","evaluation.changed");
  const previousEffects = (await tx.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM unfurl.run_steps WHERE job_id=$1) AS exists`, [job.id])).rows[0]?.exists;
  let epoch = job.retry_epoch;
  if (options.explicitPaidRetry) {
    const receiptId = IdSchema.parse(options.retryReceiptId);
    epoch = (await tx.query<{ epoch: number }>("SELECT unfurl.advance_execution_job_retry($1,$2,$3,$4,$5::jsonb) AS epoch", [receiptId,job.id,options.actorId,job.retry_epoch,JSON.stringify(input)])).rows[0]!.epoch;
  } else if (job.retry_epoch !== 0 || previousEffects) throw new ServiceFault(409,"revision_conflict","evaluation.retryRequired");
  await tx.query("UPDATE unfurl.execution_jobs SET status='queued',safe_error=NULL,updated_at=now() WHERE id=$1", [job.id]);
  await tx.query(`INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'resume') ON CONFLICT(job_id,operation)
    DO UPDATE SET dispatched_at=NULL,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=outbox.fencing_token+1,safe_error=NULL,updated_at=now()`, [randomUUID(),job.id]);
  return { jobId: job.id, retryEpoch: epoch };
}

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
