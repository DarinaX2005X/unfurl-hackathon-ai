import "server-only";
import {z} from "zod";
import {withSystemTransaction} from "../db";
import {ContextSnapshotSchema,jsonValue} from "../agent-turns/repository";
import {buildAgentDecisionRequest} from "../agent-turns/handler";
import {agentOperationId,stableExecutionId} from "../runs/identity";
import {currentReaderCapabilities} from "../research/reader-capabilities";
import {PostgresBudget} from "../budget/postgres";
import {worstCaseMicroUsd} from "../budget/calculations";
import {CAPABILITY_TEST_VERSION,PersistedCapabilityGate} from "./capabilities";
import {CANDIDATE_MODEL_POLICY,executionTiming,candidatePolicy} from "./model-policy";
import {OpenRouterModel,providerRequestDigest} from "./openrouter";
import {OpenRouterRateCards} from "./rate-card";
import {OpenRouterAccounting} from "./accounting";
import {jsonDigest} from "./json";
import {providerWireSchema} from "./wire-schema";
import type {JsonObject} from "../../domain/common";

export const SAVED_DECISION_PROBE_VERSION="saved-decision-real-schema-v1";
export const SAVED_DECISION_PROBE_MAX_MICRO_USD=909312n;
export const SavedDecisionProbeBindingSchema=z.object({jobId:z.uuid(),stepId:z.uuid()}).strict();
export type SavedDecisionProbeBinding=z.infer<typeof SavedDecisionProbeBindingSchema>;

export async function prepareSavedDecisionProbe(binding:SavedDecisionProbeBinding){
  SavedDecisionProbeBindingSchema.parse(binding);
  const saved=await withSystemTransaction("run_execution",async tx=>{
    const row=(await tx.query<{input_digest:string;schema_digest:string;step_key:string;retry_epoch:number;result_reference:unknown}>(`SELECT s.input_digest,s.schema_digest,s.step_key,j.retry_epoch,c.result_reference
      FROM unfurl.run_steps s JOIN unfurl.execution_jobs j ON j.id=s.job_id
      JOIN unfurl.run_steps c ON c.job_id=j.id AND c.step_key=replace(s.step_key,':decision',':capture') AND c.status='succeeded'
      WHERE s.id=$1 AND j.id=$2 AND j.status='failed' AND s.status='failed' AND j.agent_turn_run_id IS NOT NULL`,[binding.stepId,binding.jobId])).rows[0];
    if(!row||!/^agent\.v1:\d{6}:decision$/.test(row.step_key)||jsonDigest(row.result_reference)!==row.input_digest)throw new Error("Saved decision capture changed");
    const logical=agentOperationId(binding.stepId,"agent_decision",row.retry_epoch);
    const original=(await tx.query<{id:string;request_digest:string;state:string;reserved_micro_usd:string;provider_request_id:string|null}>(`SELECT id,request_digest,state,reserved_micro_usd::text,provider_request_id FROM unfurl.ai_provider_operations
      WHERE logical_operation_id=$1 AND attempt=1 AND run_step_id=$2`,[logical,binding.stepId])).rows[0];
    if(!original||original.id!==stableExecutionId(logical,"attempt:1"))throw new Error("Missing original decision operation");
    const endedProbes=(await tx.query<{id:string;reserved_micro_usd:string}>(`SELECT id,reserved_micro_usd::text FROM unfurl.ai_provider_operations o
      WHERE purpose='capability_probe' AND run_step_id IS NULL AND state='unknown' AND dispatched_at<now()-interval '1835 seconds'
      AND NOT EXISTS(SELECT 1 FROM unfurl.ai_provider_responses r WHERE r.operation_id=o.id) ORDER BY created_at`)).rows;
    return {row,logical,original,endedProbes};
  });
  const snapshot=ContextSnapshotSchema.parse(saved.row.result_reference);
  const originalRequest=buildAgentDecisionRequest(snapshot,{logicalOperationId:saved.logical,reservationId:saved.original.id,attempt:1,runStepId:binding.stepId,probe:false},Date.now()+executionTiming().stepMs,saved.row.retry_epoch);
  const originalOptions={schema:providerWireSchema(z.toJSONSchema(originalRequest.schema) as JsonObject),schemaName:`agent_decision_${originalRequest.schemaVersion}`};
  if(providerRequestDigest(originalRequest,originalOptions)!==saved.original.request_digest)throw new Error("Original request reconstruction differs; no paid probe allowed");
  const budgetId=z.uuid().parse(process.env.AI_BUDGET_ID);
  const logicalOperationId=stableExecutionId(budgetId,`${SAVED_DECISION_PROBE_VERSION}:${binding.stepId}`);
  const budget={logicalOperationId,reservationId:stableExecutionId(logicalOperationId,"attempt:1"),attempt:1,runStepId:null,probe:true};
  const request=buildAgentDecisionRequest(snapshot,budget,Date.now()+executionTiming().stepMs,saved.row.retry_epoch,32768,
    {modelPolicy:CANDIDATE_MODEL_POLICY,readerCapabilities:currentReaderCapabilities()});
  const rate=await new OpenRouterRateCards().current(AbortSignal.timeout(10000),CANDIDATE_MODEL_POLICY);
  const bound=worstCaseMicroUsd({contextTokens:rate.contextTokens,outputTokens:request.maxOutputTokens,inferencePasses:1,searches:0,priceCaps:candidatePolicy.priceCaps});
  if(bound>SAVED_DECISION_PROBE_MAX_MICRO_USD||rate.contextTokens>1048576||request.maxOutputTokens!==32768)throw new Error("Candidate exceeds the single approved probe allocation");
  return {request,budgetId,binding,report:{version:SAVED_DECISION_PROBE_VERSION,...binding,sourceInputDigest:saved.row.input_digest,
    sourceSchemaDigest:saved.row.schema_digest,originalOperationId:saved.original.id,originalRequestDigest:saved.original.request_digest,
    originalFinancialState:saved.original.state,originalRetainedMicroUsd:saved.original.reserved_micro_usd,originalProviderRequestId:saved.original.provider_request_id,
    candidateOperationId:budget.reservationId,candidateRequestDigest:providerRequestDigest(request,{schema:providerWireSchema(z.toJSONSchema(request.schema) as JsonObject),schemaName:`agent_decision_${request.schemaVersion}`}),
    modelPolicy:CANDIDATE_MODEL_POLICY,maxPaidCalls:1,maxExposureMicroUsd:bound.toString(),endedStandaloneProbes:saved.endedProbes}};
}

/** One immutable operation identity, no retry, no selected tool execution, no fabricated recovery. */
export async function executeSavedDecisionProbe(binding:SavedDecisionProbeBinding,expectedRequestDigest:string){
  const prepared=await prepareSavedDecisionProbe(binding);
  if(prepared.report.candidateRequestDigest!==expectedRequestDigest)throw new Error("Prepared request changed");
  const budget=new PostgresBudget(prepared.budgetId),world=process.env.VERCEL?"vercel":"local";
  const gate=new PersistedCapabilityGate(world,budget);
  const rates=new OpenRouterRateCards();
  const model=new OpenRouterModel({apiKey:()=>process.env.OPENROUTER_API_KEY,budget,gate,rateCards:{async current(signal,policy){
    const rate=await rates.current(signal,policy);
    if(rate.contextTokens>1048576)throw new Error("Endpoint bound changed");return rate;
  }}});
  const result=await model.generateStructured(prepared.request,AbortSignal.timeout(executionTiming().stepMs));
  const accounting=new OpenRouterAccounting(budget,()=>process.env.OPENROUTER_API_KEY);
  let target=await budget.reconciliationTarget(result.evidence.reservationId);
  if(target?.reservation.state!=="settled"){
    await accounting.reconcile(result.evidence.reservationId,AbortSignal.timeout(10000));
    target=await budget.reconciliationTarget(result.evidence.reservationId);
  }
  if(target?.reservation.state!=="settled")throw new Error("Probe output saved but accounting remains unknown; candidate not activated");
  const candidateGate=new PersistedCapabilityGate(world,budget,undefined,CANDIDATE_MODEL_POLICY);
  await candidateGate.observe({capability:"model_structured",passed:true,testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:86400,
    instanceId:SAVED_DECISION_PROBE_VERSION,evidence:{operationId:result.evidence.reservationId,modelPolicy:CANDIDATE_MODEL_POLICY,
      credentialDigest:jsonDigest({credential:process.env.OPENROUTER_API_KEY??""}),test:SAVED_DECISION_PROBE_VERSION,
      ...jsonValue({sourceInputDigest:prepared.report.sourceInputDigest,sourceSchemaDigest:prepared.report.sourceSchemaDigest,
        requestDigest:prepared.report.candidateRequestDigest,resultDigest:jsonDigest(result.data),selectedTool:result.data.tool}) as JsonObject}});
  return {...prepared.report,settled:true,selectedTool:result.data.tool,resultDigest:jsonDigest(result.data),decision:result.data,executedSelectedTool:false};
}

export async function retireEndedStandaloneProbe(operationId:string){
  z.uuid().parse(operationId);
  return withSystemTransaction("run_execution",async tx=>{
    const before=(await tx.query<{settled_micro_usd:string;reserved_micro_usd:string}>("SELECT settled_micro_usd::text,reserved_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE",[z.uuid().parse(process.env.AI_BUDGET_ID)])).rows[0];
    if(!before)throw new Error("Missing fixed campaign");
    const owned=(await tx.query("SELECT id FROM unfurl.ai_provider_operations WHERE id=$1 AND budget_id=$2",[operationId,process.env.AI_BUDGET_ID])).rowCount;
    if(owned!==1)throw new Error("Probe is outside the fixed campaign");
    await tx.query("SELECT unfurl.retire_ended_provider_probe($1)",[operationId]);
    const after=(await tx.query<{settled_micro_usd:string;reserved_micro_usd:string}>("SELECT settled_micro_usd::text,reserved_micro_usd::text FROM unfurl.ai_budgets WHERE id=$1",[process.env.AI_BUDGET_ID])).rows[0];
    if(jsonDigest(before)!==jsonDigest(after))throw new Error("Retirement changed financial totals");
    return {operationId,slotRetired:true,financialHoldRetained:true,totals:after};
  });
}
