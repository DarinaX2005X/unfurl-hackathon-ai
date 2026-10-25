import "server-only";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {Actor} from "../auth/actor";
import {ServiceFault} from "../auth/errors";
import type {DbTransaction} from "../db";
import type {GenerationRow} from "../curricula/repository";
import {MODEL_ID} from "../ai/constants";
import {jsonDigest,parseStructuredOutput} from "../ai/json";
import {AgentDecisionSchema,LegacyAgentDecisionSchema} from "../agent-tools/contracts";
import {agentOperationId,stableExecutionId} from "./identity";
import {appendChatEvent} from "./events";

const completeResponse=z.object({model:z.literal(MODEL_ID),provider:z.literal("DigitalOcean"),finishReason:z.literal("stop"),
  failure:z.null(),content:z.string(),rateCardDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const terminalResponse=completeResponse.extend({finishReason:z.string().min(1),failure:z.enum(["invalid_output","refused"]).nullable(),content:z.string().nullable()});
const conflict=()=>new ServiceFault(409,"revision_conflict","generation.changed");
function normalizedDecisionIsValid(content:string,capture:unknown,schemaDigest:string):boolean{
  // This exception repairs only an outer serialization wrapper, never a previously invalid
  // JSON value or decision. The shared parser must reject prose and malformed/multiple fences.
  try{JSON.parse(content);return false;}catch{/* A wrapper may be the sole parse failure. */}
  const hasSearchMemory=typeof capture==="object"&&capture!==null&&!Array.isArray(capture)&&"searchMemory" in capture&&capture.searchMemory!==undefined;
  if(schemaDigest!==jsonDigest({version:hasSearchMemory?"agent-decision-v2":"agent-decision-v1"}))return false;
  try{return (hasSearchMemory?AgentDecisionSchema:LegacyAgentDecisionSchema).safeParse(parseStructuredOutput(content)).success;}
  catch{return false;}
}

/** Called only after the public retry's ownership, current branch, latest run and intent guards.
 * A complete response lost only to timeout replays at the same epoch. A known settled terminal
 * response requires an audited explicit paid retry epoch. Succeeded steps and evidence are preserved. */
export async function resumeSavedAgentDecision(tx:DbTransaction,actor:Actor,run:GenerationRow):Promise<boolean>{
  const fault=z.object({messageKey:z.enum(["generation.timeout","generation.invalidResponse"])}).safeParse(run.error);
  if(run.status!=="failed"||!fault.success)return false;
  const job=(await tx.query<{id:string;status:string;retry_epoch:number}>("SELECT id,status,retry_epoch FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1 FOR UPDATE",[run.id])).rows[0];
  if(!job||job.status!=="failed")throw conflict();
  const held=(await tx.query(`SELECT o.id FROM unfurl.ai_provider_operations o JOIN unfurl.run_steps s ON s.id=o.run_step_id
    WHERE s.job_id=$1 AND o.state IN ('reserved','dispatched','unknown') LIMIT 1`,[job.id])).rows[0];
  if(held)throw conflict();
  const python=(await tx.query(`SELECT id FROM unfurl.code_execution_runs WHERE job_id=$1
    AND status IN ('reserved','creating','running','collecting','ambiguous','cleanup_pending') LIMIT 1`,[job.id])).rows[0];
  if(python)throw conflict();
  const unfinished=(await tx.query<{id:string;step_key:string;input_digest:string;schema_digest:string;status:string}>(`SELECT id,step_key,input_digest,schema_digest,status FROM unfurl.run_steps
    WHERE job_id=$1 AND status<>'succeeded' ORDER BY created_at FOR UPDATE`,[job.id])).rows;
  const step=unfinished[0];
  if(unfinished.length!==1||!step||step.status!=="failed"||!/^agent\.v1:\d{6}:decision$/.test(step.step_key))return false;
  const capture=(await tx.query<{result_reference:unknown}>(`SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1
    AND step_key=$2 AND status='succeeded' FOR SHARE`,[job.id,step.step_key.replace(/:decision$/ ,":capture")])).rows[0];
  if(!capture||jsonDigest(capture.result_reference)!==step.input_digest)throw conflict();
  const logical=agentOperationId(step.id,"agent_decision",job.retry_epoch),reservation=stableExecutionId(logical,"attempt:1");
  const operation=(await tx.query<{id:string;logical_operation_id:string;attempt:number;state:string;purpose:string;provider_request_id:string;
    response_provider_id:string;request_digest:string;rate_card_digest:string;result:unknown}>(`SELECT o.id,o.logical_operation_id,o.attempt,o.state,o.purpose,o.provider_request_id,
      o.request_digest,o.rate_card_digest,r.provider_request_id AS response_provider_id,r.result FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 AND o.logical_operation_id=$2 FOR SHARE OF o`,[step.id,logical])).rows;
  const paid=operation[0],response=terminalResponse.safeParse(paid?.result);
  // Unknown/missing responses cannot silently become a new run that discards saved research.
  if(operation.length!==1||!paid||paid.state!=="settled"||paid.purpose!=="turn_planning"||!response.success)throw conflict();
  if(paid.id!==reservation||paid.logical_operation_id!==logical||paid.attempt!==1||!paid.provider_request_id||
    paid.provider_request_id!==paid.response_provider_id||paid.rate_card_digest!==response.data.rateCardDigest||!/^[a-f0-9]{64}$/.test(paid.request_digest))throw conflict();
  const complete=completeResponse.safeParse(paid.result);
  const receiptOnly=complete.success&&(fault.data.messageKey==="generation.timeout"||
    normalizedDecisionIsValid(complete.data.content,capture.result_reference,step.schema_digest));
  if(!receiptOnly){
    const epoch=(await tx.query<{epoch:number}>("SELECT unfurl.advance_execution_job_retry($1,$2,$3,$4,$5::jsonb) AS epoch",
      [randomUUID(),job.id,actor.id,job.retry_epoch,JSON.stringify({kind:"agent_turn",runId:run.id})])).rows[0]?.epoch;
    if(epoch!==job.retry_epoch+1)throw conflict();
  }
  // Same-epoch replay reconstructs and verifies request_digest before returning the receipt;
  // a newly audited epoch allocates only this failed decision's new provider operation.
  await tx.query("UPDATE unfurl.run_steps SET status='pending',error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[step.id]);
  await tx.query("UPDATE unfurl.execution_jobs SET status='queued',safe_error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[job.id]);
  await tx.query("UPDATE unfurl.agent_turn_runs SET status='queued',error=NULL,updated_at=now() WHERE id=$1",[run.id]);
  await appendChatEvent(tx,{kind:"agent_turn",runId:run.id,ownerId:actor.id,conversationId:run.conversation_id,branchId:run.branch_id,inputMessageId:run.input_message_id},
    {type:"run.accepted",status:"queued"});
  await tx.query(`INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'resume') ON CONFLICT(job_id,operation) DO UPDATE SET
    dispatched_at=NULL,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=outbox.fencing_token+1,safe_error=NULL,updated_at=now()`,[randomUUID(),job.id]);
  return true;
}
