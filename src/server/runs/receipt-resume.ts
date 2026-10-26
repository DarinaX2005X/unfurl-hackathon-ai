import "server-only";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {Actor} from "../auth/actor";
import {ServiceFault} from "../auth/errors";
import type {DbTransaction} from "../db";
import type {GenerationRow} from "../curricula/repository";
import {readActiveModelPolicy} from "../ai/active-policy";
import {currentReaderCapabilities} from "../research/reader-capabilities";
import {MODEL_ID} from "../ai/constants";
import {OpenRouterAccounting} from "../ai/accounting";
import {PostgresBudget} from "../budget/postgres";
import {jsonDigest,parseStructuredOutput} from "../ai/json";
import {AgentDecisionReceiptSchema,agentDecisionSchemaForCapture} from "../agent-tools/contracts";
import {agentToolStepInput} from "../agent-tools/executor";
import {agentOperationId,stableExecutionId} from "./identity";
import {saveAgentDecisionRetryPolicy} from "./decision-policy";
import {appendChatEvent} from "./events";

const completeResponse=z.object({model:z.enum([MODEL_ID,"google/gemini-3.8-flash"]),provider:z.enum(["DigitalOcean","Google AI Studio"]),finishReason:z.literal("stop"),
  failure:z.null(),content:z.string(),rateCardDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const terminalResponse=completeResponse.extend({finishReason:z.string().min(1),failure:z.enum(["invalid_output","refused"]).nullable(),content:z.string().nullable()});
const conflict=()=>new ServiceFault(409,"revision_conflict","generation.changed");
function normalizedDecisionIsValid(content:string,capture:unknown,schemaDigest:string):boolean{
  if(typeof capture!=="object"||capture===null||Array.isArray(capture))return false;
  const selected=agentDecisionSchemaForCapture(capture);
  if(schemaDigest!==jsonDigest({version:`agent-decision-v${selected.schemaVersion}`}))return false;
  try{
    const parsed=parseStructuredOutput(content);
    if(!selected.schema.safeParse(parsed).success)return false;
    // Only the complete outer JSON fence and surrounding domain-hint whitespace are
    // replay exceptions. Full original-version validation still rejects other repairs.
    try{JSON.parse(content);}catch{return true;}
    const search=z.object({tool:z.literal("search"),input:z.object({domainHints:z.array(z.string())})}).safeParse(parsed);
    return search.success&&search.data.input.domainHints.some(domain=>domain!==domain.trim());
  }catch{return false;}
}

/** Reconcile an owned current saved search before admission counts outstanding calls.
 * This neither resumes a run nor allocates an attempt. The normal retry rechecks all
 * branch/intent guards and admission after this idempotent accounting transaction. */
export async function reconcileSavedSearchBeforeRetry(tx:DbTransaction,actor:Actor,runId:string):Promise<void>{
  const job=(await tx.query<{id:string;retry_epoch:number}>(`SELECT j.id,j.retry_epoch FROM unfurl.execution_jobs j
    JOIN unfurl.agent_turn_runs r ON r.id=j.agent_turn_run_id
    JOIN unfurl.conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
    WHERE r.id=$1 AND r.owner_id=$2 AND c.deleted_at IS NULL AND c.active_branch_id=r.branch_id
      AND r.status='failed' AND j.status='failed' AND r.error->>'messageKey' IN ('generation.unavailable','generation.timeout','generation.invalidResponse')
      AND r.id=(SELECT latest.id FROM unfurl.agent_turn_runs latest WHERE latest.conversation_id=r.conversation_id
        AND latest.branch_id=r.branch_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
    FOR UPDATE OF j`,[runId,actor.id])).rows[0];
  if(!job)return;
  const unfinished=(await tx.query<{id:string;step_key:string;input_digest:string;schema_digest:string;status:string}>(`SELECT id,step_key,input_digest,schema_digest,status FROM unfurl.run_steps
    WHERE job_id=$1 AND status<>'succeeded' ORDER BY created_at FOR UPDATE`,[job.id])).rows;
  const step=unfinished[0];
  if(unfinished.length===1&&step?.status==="failed"&&/^agent\.v1:\d{6}:tool$/.test(step.step_key))await reconcileSavedSearch(tx,runId,job,step);
}

/** Called only after the public retry's ownership, current branch, latest run and intent guards.
 * A complete response lost only to timeout replays at the same epoch. A known settled terminal
 * response requires an audited explicit paid retry epoch. Succeeded steps and evidence are preserved. */
export async function resumeSavedAgentDecision(tx:DbTransaction,actor:Actor,run:GenerationRow):Promise<boolean>{
  const fault=z.object({messageKey:z.enum(["generation.timeout","generation.invalidResponse","generation.unavailable"])}).safeParse(run.error);
  if(run.status!=="failed"||!fault.success)return false;
  const job=(await tx.query<{id:string;status:string;retry_epoch:number}>("SELECT id,status,retry_epoch FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1 FOR UPDATE",[run.id])).rows[0];
  if(!job||job.status!=="failed")throw conflict();
  const unfinished=(await tx.query<{id:string;step_key:string;input_digest:string;schema_digest:string;status:string}>(`SELECT id,step_key,input_digest,schema_digest,status FROM unfurl.run_steps
    WHERE job_id=$1 AND status<>'succeeded' ORDER BY created_at FOR UPDATE`,[job.id])).rows;
  const step=unfinished[0];
  const searchStep=unfinished.length===1&&step?.status==="failed"&&/^agent\.v1:\d{6}:tool$/.test(step.step_key);
  const recoveredSearch=searchStep&&await reconcileSavedSearch(tx,run.id,job,step);
  const held=(await tx.query(`SELECT o.id FROM unfurl.ai_provider_operations o JOIN unfurl.run_steps s ON s.id=o.run_step_id
    WHERE s.job_id=$1 AND o.state IN ('reserved','dispatched','unknown') AND NOT EXISTS(
      SELECT 1 FROM unfurl.ai_provider_attempt_retirements retired JOIN unfurl.execution_job_retry_receipts retry
        ON retry.job_id=retired.job_id AND retry.from_epoch=retired.from_epoch AND retry.to_epoch=retired.to_epoch AND retry.actor_id=retired.actor_id
      WHERE retired.operation_id=o.id AND retired.kind='explicit_decision_retry' AND retired.job_id=$1 AND retired.actor_id=$2
        AND retired.request_digest=o.request_digest AND retired.retained_micro_usd=o.reserved_micro_usd AND retry.to_epoch<=$3)
    LIMIT 1`,[job.id,actor.id,job.retry_epoch])).rows[0];
  if(held&&!(unfinished.length===1&&step?.status==="failed"&&/^agent\.v1:\d{6}:decision$/.test(step.step_key)))throw conflict();
  const python=(await tx.query(`SELECT id FROM unfurl.code_execution_runs WHERE job_id=$1
    AND status IN ('reserved','creating','running','collecting','ambiguous','cleanup_pending') LIMIT 1`,[job.id])).rows[0];
  if(python)throw conflict();
  if(recoveredSearch){await requeueSavedStep(tx,actor,run,job.id,step.id);return true;}
  
  if(unfinished.length!==1||!step||step.status!=="failed"||!/^agent\.v1:\d{6}:decision$/.test(step.step_key))return false;
  const capture=(await tx.query<{result_reference:unknown}>(`SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1
    AND step_key=$2 AND status='succeeded' FOR SHARE`,[job.id,step.step_key.replace(/:decision$/ ,":capture")])).rows[0];
  if(!capture||jsonDigest(capture.result_reference)!==step.input_digest)throw conflict();
  const logical=agentOperationId(step.id,"agent_decision",job.retry_epoch),reservation=stableExecutionId(logical,"attempt:1");
  const operation=(await tx.query<{id:string;logical_operation_id:string;attempt:number;state:string;purpose:string;provider_request_id:string;
    response_provider_id:string;request_digest:string;rate_card_digest:string;result:unknown;safe_failure_code:string;has_response:boolean}>(`SELECT o.id,o.logical_operation_id,o.attempt,o.state,o.purpose,o.provider_request_id,
      o.request_digest,o.rate_card_digest,o.safe_failure_code,r.operation_id IS NOT NULL AS has_response,r.provider_request_id AS response_provider_id,r.result FROM unfurl.ai_provider_operations o
      LEFT JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 AND o.logical_operation_id=$2`,[step.id,logical])).rows;
  const paid=operation[0],response=terminalResponse.safeParse(paid?.result);
  const ambiguous=operation.length===1&&paid&&paid.state==="unknown"&&!paid.has_response&&
    paid.purpose==="turn_planning"&&paid.id===reservation&&paid.logical_operation_id===logical&&paid.attempt===1&&
    ["timeout","unavailable","cancelled"].includes(paid.safe_failure_code)&&/^[a-f0-9]{64}$/.test(paid.request_digest);
  if(ambiguous){
    const authorizedPolicy=await readActiveModelPolicy(tx);
    await tx.query("SELECT unfurl.authorize_ambiguous_decision_retry($1,$2,$3,$4,$5,$6,$7)",[paid.id,actor.id,job.id,step.id,job.retry_epoch,authorizedPolicy,jsonDigest(currentReaderCapabilities())]);
    const epoch=(await tx.query<{epoch:number}>("SELECT unfurl.advance_execution_job_retry($1,$2,$3,$4,$5::jsonb) AS epoch",
      [randomUUID(),job.id,actor.id,job.retry_epoch,JSON.stringify({kind:"agent_turn",runId:run.id})])).rows[0]?.epoch;
    if(epoch!==job.retry_epoch+1)throw conflict();
    await saveAgentDecisionRetryPolicy(tx,{jobId:job.id,runId:run.id,decisionStepId:step.id,retryEpoch:epoch,inputDigest:step.input_digest,schemaDigest:step.schema_digest},authorizedPolicy);
    await requeueSavedStep(tx,actor,run,job.id,step.id);return true;
  }
  if(held)throw conflict();
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
    await saveAgentDecisionRetryPolicy(tx,{jobId:job.id,runId:run.id,decisionStepId:step.id,retryEpoch:epoch,
      inputDigest:step.input_digest,schemaDigest:step.schema_digest});
  }
  // Same-epoch replay reconstructs and verifies request_digest before returning the receipt;
  // a newly audited epoch allocates only this failed decision's new provider operation.
  await requeueSavedStep(tx,actor,run,job.id,step.id);
  return true;
}

/** No provider I/O: the original authenticated receipt must prove the full search charge.
 * Replaying the step subsequently verifies the original request digest before using its result. */
async function reconcileSavedSearch(tx:DbTransaction,runId:string,job:{id:string;retry_epoch:number},step:{id:string;step_key:string;input_digest:string;schema_digest:string}){
  const decisionRow=(await tx.query<{result_reference:unknown;input_digest:string}>(`SELECT result_reference,input_digest FROM unfurl.run_steps
    WHERE job_id=$1 AND step_key=$2 AND status='succeeded' FOR SHARE`,[job.id,step.step_key.replace(/:tool$/,":decision")])).rows[0];
  const capture=(await tx.query<{result_reference:unknown}>(`SELECT result_reference FROM unfurl.run_steps
    WHERE job_id=$1 AND step_key=$2 AND status='succeeded' FOR SHARE`,[job.id,step.step_key.replace(/:tool$/,":capture")])).rows[0];
  const decision=AgentDecisionReceiptSchema.safeParse(decisionRow?.result_reference);
  if(decision.success&&decision.data.decision.tool!=="search")return false;
  if(!capture||!decisionRow||jsonDigest(capture.result_reference)!==decisionRow.input_digest||!decision.success||
    decision.data.decision.tool!=="search"||decision.data.preparationError!==null||
    step.step_key!==`agent.v1:${String(decision.data.index).padStart(6,"0")}:tool`||
    decision.data.invocationId!==stableExecutionId(runId,`tool:${decision.data.index}`)||
    step.id!==stableExecutionId(job.id,step.step_key)||step.input_digest!==jsonDigest(agentToolStepInput(decision.data))||
    step.schema_digest!==jsonDigest({version:"agent-tool-output-v1"}))throw conflict();
  const logical=agentOperationId(step.id,"research_search",job.retry_epoch);
  const rows=(await tx.query<{id:string;budget_id:string;attempt:number;state:string;purpose:string;provider_request_id:string;
    response_provider_id:string;request_digest:string;rate_card_digest:string;rate_card:unknown;result:unknown}>(`SELECT o.id,o.budget_id,o.attempt,o.state,o.purpose,o.provider_request_id,
      o.request_digest,o.rate_card_digest,o.rate_card,r.provider_request_id AS response_provider_id,r.result FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 AND o.logical_operation_id=$2`,[step.id,logical])).rows;
  const paid=rows[0],response=completeResponse.safeParse(paid?.result);
  if(rows.length!==1||!paid||!response.success||paid.id!==stableExecutionId(logical,"attempt:1")||paid.attempt!==1||
    !["unknown","settled"].includes(paid.state)||paid.purpose!=="web_search"||!paid.provider_request_id||
    paid.provider_request_id!==paid.response_provider_id||paid.rate_card_digest!==response.data.rateCardDigest||
    paid.rate_card_digest!==jsonDigest(paid.rate_card,64*1024)||!/^[a-f0-9]{64}$/.test(paid.request_digest))throw conflict();
  const budget=new PostgresBudget(paid.budget_id,work=>work(tx));
  const proof=await new OpenRouterAccounting(budget,()=>undefined).reconcile(paid.id,new AbortController().signal,{nativeOnly:true});
  if(!proof.settled||!proof.searchFeeVerified)throw conflict();
  return true;
}

async function requeueSavedStep(tx:DbTransaction,actor:Actor,run:GenerationRow,jobId:string,stepId:string){
  await tx.query("UPDATE unfurl.run_steps SET status='pending',error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[stepId]);
  await tx.query("UPDATE unfurl.execution_jobs SET status='queued',safe_error=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1",[jobId]);
  await tx.query("UPDATE unfurl.agent_turn_runs SET status='queued',error=NULL,updated_at=now() WHERE id=$1",[run.id]);
  await appendChatEvent(tx,{kind:"agent_turn",runId:run.id,ownerId:actor.id,conversationId:run.conversation_id,branchId:run.branch_id,inputMessageId:run.input_message_id},
    {type:"run.accepted",status:"queued"});
  await tx.query(`INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'resume') ON CONFLICT(job_id,operation) DO UPDATE SET
    dispatched_at=NULL,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=outbox.fencing_token+1,safe_error=NULL,updated_at=now()`,[randomUUID(),jobId]);
}
