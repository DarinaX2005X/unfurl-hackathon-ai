import "server-only";
import {z} from "zod";
import type {DbTransaction} from "../db";
import {ServiceFault} from "../auth/errors";
import {jsonDigest} from "../ai/json";
import {stableExecutionId} from "./identity";
import {readActiveModelPolicy} from "../ai/active-policy";
import {ModelPolicySchema,type ModelPolicyId} from "../ai/model-policy";
import {currentReaderCapabilities,ReaderCapabilitiesSchema} from "../research/reader-capabilities";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({jobId:z.uuid(),runId:z.uuid(),decisionStepId:z.uuid(),retryEpoch:z.number().int().positive(),
  inputDigest:digest,schemaDigest:digest}).strict();
export type AgentDecisionRetryBinding=z.infer<typeof bindingSchema>;
const policySchema=bindingSchema.extend({version:z.literal("planner-headroom-v1"),maxOutputTokens:z.literal(32768)}).strict();
const policyDigest=jsonDigest({version:"agent-decision-retry-policy-v1"});
const key=(binding:AgentDecisionRetryBinding)=>`agent-retry-policy.v1:${binding.decisionStepId}:${binding.retryEpoch}`;
const unavailable=()=>new ServiceFault(503,"service_unavailable","generation.recoveryUnavailable");

/** The caller holds the failed job lock and has just appended the matching explicit retry audit.
 * A separate journal namespace preserves every original capture and paid request byte. */
export async function saveAgentDecisionRetryPolicy(tx:DbTransaction,binding:AgentDecisionRetryBinding,authorizedPolicy?:ModelPolicyId):Promise<void>{
  bindingSchema.parse(binding);
  const stepKey=key(binding),result={...binding,version:"planner-headroom-v1",maxOutputTokens:32768};
  await tx.query(`INSERT INTO unfurl.run_steps
    (id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,result_reference)
    VALUES($1,$2,$3,$4,$5,$5,$5,'succeeded',$6::jsonb)`,
  [stableExecutionId(binding.jobId,stepKey),binding.jobId,stepKey,jsonDigest(binding),policyDigest,JSON.stringify(result)]);
  {
    const selectedPolicy=authorizedPolicy??await readActiveModelPolicy(tx);
    const nextKey=`agent-retry-model.v2:${binding.decisionStepId}:${binding.retryEpoch}`;
    const next={...binding,version:"planner-model-retry-v2",modelPolicy:selectedPolicy,readerCapabilities:currentReaderCapabilities()};
    const digest=jsonDigest({version:"planner-model-retry-v2"});
    await tx.query(`INSERT INTO unfurl.run_steps(id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,result_reference)
      VALUES($1,$2,$3,$4,$5,$5,$5,'succeeded',$6::jsonb)`,[stableExecutionId(binding.jobId,nextKey),binding.jobId,nextKey,jsonDigest(binding),digest,JSON.stringify(next)]);
  }
}

const modelRetrySchema=bindingSchema.extend({version:z.literal("planner-model-retry-v2"),modelPolicy:ModelPolicySchema,readerCapabilities:ReaderCapabilitiesSchema}).strict();
export async function readAgentDecisionModelRetryPolicy(tx:DbTransaction,binding:AgentDecisionRetryBinding){
  if(binding.retryEpoch===0)return null;
  const stepKey=`agent-retry-model.v2:${binding.decisionStepId}:${binding.retryEpoch}`;
  const row=(await tx.query<{id:string;input_digest:string;schema_digest:string;capability_digest:string;validation_policy_digest:string;result_reference:unknown;semantic_target:unknown;authorized_model_policy:string|null;reader_policy_digest:string|null}>(`SELECT s.*,r.semantic_target,a.authorized_model_policy,a.reader_policy_digest FROM unfurl.run_steps s
    JOIN unfurl.execution_job_retry_receipts r ON r.job_id=s.job_id AND r.to_epoch=$3
    LEFT JOIN unfurl.ai_provider_attempt_retirements a ON a.job_id=r.job_id AND a.to_epoch=r.to_epoch AND a.actor_id=r.actor_id AND a.step_id=$4
    WHERE s.job_id=$1 AND s.step_key=$2 AND s.status='succeeded'`,[binding.jobId,stepKey,binding.retryEpoch,binding.decisionStepId])).rows[0];
  if(!row)return null;
  const parsed=modelRetrySchema.safeParse(row.result_reference),digest=jsonDigest({version:"planner-model-retry-v2"});
  if(!parsed.success||row.id!==stableExecutionId(binding.jobId,stepKey)||row.input_digest!==jsonDigest(binding)||row.schema_digest!==digest||row.capability_digest!==digest||row.validation_policy_digest!==digest||
    jsonDigest({jobId:parsed.data.jobId,runId:parsed.data.runId,decisionStepId:parsed.data.decisionStepId,retryEpoch:parsed.data.retryEpoch,inputDigest:parsed.data.inputDigest,schemaDigest:parsed.data.schemaDigest})!==jsonDigest(binding)||jsonDigest(row.semantic_target)!==jsonDigest({kind:"agent_turn",runId:binding.runId})||
    (row.authorized_model_policy!=null&&(row.authorized_model_policy!==parsed.data.modelPolicy||row.reader_policy_digest!==jsonDigest(parsed.data.readerCapabilities))))throw unavailable();
  return {modelPolicy:parsed.data.modelPolicy,readerCapabilities:parsed.data.readerCapabilities};
}

/** Missing receipts retain the historical request policy. A present receipt must match both
 * the exact decision identity and the immutable user-authorized retry audit. */
export async function readAgentDecisionRetryPolicy(tx:DbTransaction,binding:AgentDecisionRetryBinding):Promise<32768|null>{
  if(binding.retryEpoch===0)return null;
  bindingSchema.parse(binding);
  const stepKey=key(binding);
  const rows=(await tx.query<{id:string;input_digest:string;schema_digest:string;capability_digest:string;
    validation_policy_digest:string;status:string;result_reference:unknown;semantic_target:unknown}>(`SELECT s.id,s.input_digest,s.schema_digest,s.capability_digest,
      s.validation_policy_digest,s.status,s.result_reference,r.semantic_target FROM unfurl.run_steps s
      LEFT JOIN unfurl.execution_job_retry_receipts r ON r.job_id=s.job_id AND r.to_epoch=$3
      WHERE s.job_id=$1 AND s.step_key=$2`,[binding.jobId,stepKey,binding.retryEpoch])).rows;
  if(rows.length===0)return null;
  const row=rows[0],parsed=policySchema.safeParse(row?.result_reference);
  if(rows.length!==1||!row||!parsed.success||row.id!==stableExecutionId(binding.jobId,stepKey)||row.status!=="succeeded"||
    row.input_digest!==jsonDigest(binding)||row.schema_digest!==policyDigest||row.capability_digest!==policyDigest||
    row.validation_policy_digest!==policyDigest||jsonDigest(parsed.data)!==jsonDigest({...binding,version:"planner-headroom-v1",maxOutputTokens:32768})||
    jsonDigest(row.semantic_target??null)!==jsonDigest({kind:"agent_turn",runId:binding.runId}))throw unavailable();
  return parsed.data.maxOutputTokens;
}
