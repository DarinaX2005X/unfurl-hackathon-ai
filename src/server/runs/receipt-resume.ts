import "server-only";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {Actor} from "../auth/actor";
import {ServiceFault} from "../auth/errors";
import type {DbTransaction} from "../db";
import type {GenerationRow} from "../curricula/repository";
import {MODEL_ID} from "../ai/constants";
import {jsonDigest} from "../ai/json";
import {stableExecutionId} from "./identity";
import {appendChatEvent} from "./events";

const completeResponse=z.object({model:z.literal(MODEL_ID),provider:z.literal("DigitalOcean"),finishReason:z.literal("stop"),
  failure:z.null(),content:z.string(),rateCardDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const conflict=()=>new ServiceFault(409,"revision_conflict","generation.changed");

/** Called only after the public retry's ownership, current branch, latest run and intent guards.
 * This reopens one uncommitted decision using its existing settled receipt. It allocates no new
 * provider identity or retry epoch, and never copies or edits succeeded steps or paid evidence. */
export async function resumeSavedAgentDecision(tx:DbTransaction,actor:Actor,run:GenerationRow):Promise<boolean>{
  if(run.status!=="failed"||!z.object({messageKey:z.literal("generation.timeout")}).safeParse(run.error).success)return false;
  const job=(await tx.query<{id:string;status:string}>("SELECT id,status FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1 FOR UPDATE",[run.id])).rows[0];
  if(!job||job.status!=="failed")throw conflict();
  const held=(await tx.query(`SELECT o.id FROM unfurl.ai_provider_operations o JOIN unfurl.run_steps s ON s.id=o.run_step_id
    WHERE s.job_id=$1 AND o.state IN ('reserved','dispatched','unknown') LIMIT 1`,[job.id])).rows[0];
  if(held)throw conflict();
  const python=(await tx.query(`SELECT id FROM unfurl.code_execution_runs WHERE job_id=$1
    AND status IN ('reserved','creating','running','collecting','ambiguous','cleanup_pending') LIMIT 1`,[job.id])).rows[0];
  if(python)throw conflict();
  const unfinished=(await tx.query<{id:string;step_key:string;input_digest:string;status:string}>(`SELECT id,step_key,input_digest,status FROM unfurl.run_steps
    WHERE job_id=$1 AND status<>'succeeded' ORDER BY created_at FOR UPDATE`,[job.id])).rows;
  const step=unfinished[0];
  if(unfinished.length!==1||!step||step.status!=="failed"||!/^agent\.v1:\d{6}:decision$/.test(step.step_key))return false;
  const capture=(await tx.query<{result_reference:unknown}>(`SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1
    AND step_key=$2 AND status='succeeded' FOR SHARE`,[job.id,step.step_key.replace(/:decision$/ ,":capture")])).rows[0];
  if(!capture||jsonDigest(capture.result_reference)!==step.input_digest)throw conflict();
  const logical=stableExecutionId(step.id,"agent_decision"),reservation=stableExecutionId(logical,"attempt:1");
  const operation=(await tx.query<{id:string;logical_operation_id:string;attempt:number;state:string;purpose:string;provider_request_id:string;
    response_provider_id:string;request_digest:string;rate_card_digest:string;result:unknown}>(`SELECT o.id,o.logical_operation_id,o.attempt,o.state,o.purpose,o.provider_request_id,
      o.request_digest,o.rate_card_digest,r.provider_request_id AS response_provider_id,r.result FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 FOR SHARE OF o`,[step.id])).rows;
  const paid=operation[0],response=completeResponse.safeParse(paid?.result);
  if(operation.length!==1||!paid||paid.state!=="settled"||paid.purpose!=="turn_planning"||!response.success)return false;
  if(paid.id!==reservation||paid.logical_operation_id!==logical||paid.attempt!==1||!paid.provider_request_id||
    paid.provider_request_id!==paid.response_provider_id||paid.rate_card_digest!==response.data.rateCardDigest||!/^[a-f0-9]{64}$/.test(paid.request_digest))throw conflict();
  // Replay reconstructs the exact request from the immutable capture and checks request_digest
  // before returning this receipt. Domain JSON/schema validation then runs normally, without fetch.
  await tx.query("UPDATE unfurl.run_steps SET status='pending',error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[step.id]);
  await tx.query("UPDATE unfurl.execution_jobs SET status='queued',safe_error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[job.id]);
  await tx.query("UPDATE unfurl.agent_turn_runs SET status='queued',error=NULL,updated_at=now() WHERE id=$1",[run.id]);
  await appendChatEvent(tx,{kind:"agent_turn",runId:run.id,ownerId:actor.id,conversationId:run.conversation_id,branchId:run.branch_id,inputMessageId:run.input_message_id},
    {type:"run.accepted",status:"queued"});
  await tx.query(`INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'resume') ON CONFLICT(job_id,operation) DO UPDATE SET
    dispatched_at=NULL,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=outbox.fencing_token+1,safe_error=NULL,updated_at=now()`,[randomUUID(),job.id]);
  return true;
}
