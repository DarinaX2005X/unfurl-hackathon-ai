import "server-only";
import { randomUUID } from "node:crypto";
import { ChatEventSchema, type ChatEvent } from "../../domain/generation";
import { GenerationEventSchema, type GenerationEvent } from "../../domain/generation-observer";
import type { DbTransaction } from "../db";
import { ProviderFailure } from "../ai/failure";
import type { ChatEventPayload, ExecutionTarget, GenerationEventPayload, JobClaim } from "./ports";

export async function appendChatEvent(tx: DbTransaction, target: Extract<ExecutionTarget, { kind: "agent_turn" }>, payload: ChatEventPayload): Promise<ChatEvent> {
  const row = (await tx.query<{ last_seq: number; updated_at: Date | string }>(`UPDATE unfurl.agent_turn_runs
    SET last_seq=last_seq+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND branch_id=$3 RETURNING last_seq,updated_at`,
  [target.runId, target.ownerId, target.branchId])).rows[0];
  if (!row) throw new ProviderFailure("cancelled");
  let safePayload = payload;
  if (payload.type === "action.started") {
    safePayload = { type: payload.type, invocationId: payload.invocationId, action: payload.action, labelKey: "generation.action." + payload.action };
  }
  if (payload.type === "action.completed" && payload.resultSummary.length > 1000) throw new ProviderFailure("invalid_output");
  const event = ChatEventSchema.parse({ ...safePayload, id: randomUUID(), runId: target.runId, branchId: target.branchId,
    seq: row.last_seq, at: new Date(row.updated_at).toISOString() });
  await tx.query("INSERT INTO unfurl.agent_turn_events (id,run_id,branch_id,seq,type,event,at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [event.id, event.runId, event.branchId, event.seq, event.type, JSON.stringify(event), event.at]);
  return event;
}
export async function appendGenerationEvent(tx: DbTransaction, target: Extract<ExecutionTarget, { kind: "generation" }>, payload: GenerationEventPayload): Promise<GenerationEvent> {
  const row = (await tx.query<{ last_seq: number; updated_at: Date | string }>(`UPDATE unfurl.generation_runs
    SET last_seq=last_seq+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND branch_id=$3 AND course_id=$4 RETURNING last_seq,updated_at`,
  [target.runId, target.ownerId, target.branchId, target.courseId])).rows[0];
  if (!row) throw new ProviderFailure("cancelled");
  const event = GenerationEventSchema.parse({ ...payload, id: randomUUID(), runId: target.runId, courseId: target.courseId,
    branchId: target.branchId, seq: row.last_seq, at: new Date(row.updated_at).toISOString() });
  if (event.type === "generation.phase.changed") await tx.query("UPDATE unfurl.generation_runs SET phase=$2 WHERE id=$1", [target.runId, event.phase]);
  await tx.query("INSERT INTO unfurl.generation_events (id,run_id,branch_id,seq,type,event,at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [event.id, event.runId, event.branchId, event.seq, event.type, JSON.stringify(event), event.at]);
  return event;
}

async function finishJob(tx: DbTransaction, claim: JobClaim, status: "succeeded" | "waiting") {
  const result = await tx.query(`UPDATE unfurl.execution_jobs SET status=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND status='running' AND lease_expires_at>now() RETURNING id`,
  [claim.jobId, claim.leaseOwner, claim.fencingToken, status]);
  if (result.rowCount !== 1) throw new ProviderFailure("cancelled");
}
export async function completeTurnInTransaction(tx: DbTransaction, claim: JobClaim, status: "succeeded" | "awaiting_user"): Promise<void> {
  if (claim.target.kind !== "agent_turn") throw new ProviderFailure("invalid_output");
  const run = await tx.query("UPDATE unfurl.agent_turn_runs SET status=$2,error=NULL,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [claim.target.runId, status]);
  if (run.rowCount !== 1) throw new ProviderFailure("cancelled");
  await appendChatEvent(tx, claim.target, status === "succeeded" ? { type: "run.completed" } : { type: "run.awaiting_user" });
  await finishJob(tx, claim, status === "succeeded" ? "succeeded" : "waiting");
}
export async function completeGenerationInTransaction(tx: DbTransaction, claim: JobClaim, courseVersionId: string): Promise<void> {
  if (claim.target.kind !== "generation" || claim.target.courseVersionId !== courseVersionId) throw new ProviderFailure("invalid_output");
  const target = claim.target;
  const ready = (await tx.query<{ id: string }>(`SELECT v.id FROM unfurl.course_versions v
    JOIN unfurl.courses c ON c.id=v.course_id AND c.current_ready_version_id=v.id AND c.owner_id=$5
    WHERE v.id=$1 AND v.course_id=$2 AND v.source_run_id=$3 AND v.approval_id=$4 AND v.state='ready'
    AND v.validation_receipt_id IS NOT NULL AND v.content_digest=$6`,
  [courseVersionId, target.courseId, target.runId, target.approvalId, target.ownerId, target.approvalDigest])).rows[0];
  if (!ready) throw new ProviderFailure("invalid_output");
  const run = await tx.query("UPDATE unfurl.generation_runs SET status='succeeded',output_version_id=$2,error=NULL,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [target.runId, courseVersionId]);
  if (run.rowCount !== 1) throw new ProviderFailure("cancelled");
  await appendGenerationEvent(tx, target, { type: "generation.succeeded", courseVersionId });
  await finishJob(tx, claim, "succeeded");
}
