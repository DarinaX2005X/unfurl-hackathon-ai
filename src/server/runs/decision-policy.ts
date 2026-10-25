import "server-only";
import {z} from "zod";
import type {DbTransaction} from "../db";
import {ServiceFault} from "../auth/errors";
import {jsonDigest} from "../ai/json";
import {stableExecutionId} from "./identity";

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
export async function saveAgentDecisionRetryPolicy(tx:DbTransaction,binding:AgentDecisionRetryBinding):Promise<void>{
  bindingSchema.parse(binding);
  const stepKey=key(binding),result={...binding,version:"planner-headroom-v1",maxOutputTokens:32768};
  await tx.query(`INSERT INTO unfurl.run_steps
    (id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,result_reference)
    VALUES($1,$2,$3,$4,$5,$5,$5,'succeeded',$6::jsonb)`,
  [stableExecutionId(binding.jobId,stepKey),binding.jobId,stepKey,jsonDigest(binding),policyDigest,JSON.stringify(result)]);
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
