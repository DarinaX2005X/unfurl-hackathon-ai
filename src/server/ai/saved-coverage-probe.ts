import "server-only";
import {z} from "zod";
import type {JsonObject} from "../../domain/common";
import {withSystemTransaction,type DbTransaction} from "../db";
import {PostgresBudget} from "../budget/postgres";
import {worstCaseMicroUsd} from "../budget/calculations";
import {stableExecutionId} from "../runs/identity";
import {assessKnowledgeCoverageReview} from "../course-validation/knowledge";
import {CAPABILITY_TEST_VERSION,PersistedCapabilityGate,type CapabilityTransaction} from "./capabilities";
import {CANDIDATE_MODEL_POLICY,GEMINI_SCHEMA_V3_PROOF,candidatePolicy,executionTiming} from "./model-policy";
import {OpenRouterModel,providerRequestDigest} from "./openrouter";
import {OpenRouterRateCards} from "./rate-card";
import {OpenRouterAccounting} from "./accounting";
import {jsonDigest,parseStructuredOutput} from "./json";
import {coverageProbeRequest,coverageRequestOptions,loadSavedCoverageRequest,SavedCoverageProbeBindingSchema,type SavedCoverageProbeBinding} from "./saved-coverage-request";

export const SAVED_COVERAGE_PROBE_MAX_MICRO_USD=847872n;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const readOnly:CapabilityTransaction=work=>withSystemTransaction("run_execution",async tx=>{await tx.query("SET TRANSACTION READ ONLY");return work(tx);});

export function coverageProbeBudget(budgetId:string,stepId:string){
  z.uuid().parse(budgetId);z.uuid().parse(stepId);
  const logicalOperationId=stableExecutionId(budgetId,`${GEMINI_SCHEMA_V3_PROOF}:${stepId}`);
  return {logicalOperationId,reservationId:stableExecutionId(logicalOperationId,"attempt:1"),attempt:1,runStepId:null,probe:true};
}

/** Unpaid preparation: no provider endpoint calls, reservations or mutations. */
export async function prepareSavedCoverageProbe(binding:SavedCoverageProbeBinding,run:CapabilityTransaction=readOnly){
  SavedCoverageProbeBindingSchema.parse(binding);
  const budgetId=z.uuid().parse(process.env.AI_BUDGET_ID),saved=await run(tx=>loadSavedCoverageRequest(tx,binding));
  if(saved.original.budget_id!==budgetId)throw new Error("Coverage source belongs to another campaign");
  const budget=coverageProbeBudget(budgetId,binding.stepId),request=coverageProbeRequest(saved,budget,Date.now()+executionTiming().stepMs);
  const options=coverageRequestOptions(request),bound=worstCaseMicroUsd({contextTokens:1048576,outputTokens:request.maxOutputTokens,inferencePasses:1,searches:0,priceCaps:candidatePolicy.priceCaps});
  if(bound!==SAVED_COVERAGE_PROBE_MAX_MICRO_USD||request.maxOutputTokens!==16384)throw new Error("Coverage probe exceeds its one-attempt allocation");
  return {request,budgetId,report:{version:GEMINI_SCHEMA_V3_PROOF,...binding,sourceKnowledgeStepId:saved.sourceKnowledgeStepId,
    sourceInputDigest:saved.sourceInputDigest,sourceSchemaDigest:saved.sourceSchemaDigest,canonicalSchemaDigest:saved.canonicalSchemaDigest,
    originalOperationId:saved.original.id,originalRequestDigest:saved.original.request_digest,originalFinancialState:saved.original.state,
    originalRetainedMicroUsd:saved.original.reserved_micro_usd,originalProviderRequestId:saved.original.provider_request_id,
    candidateOperationId:budget.reservationId,candidateRequestDigest:providerRequestDigest(request,options),modelPolicy:CANDIDATE_MODEL_POLICY,
    maxPaidCalls:1 as const,maxExposureMicroUsd:bound.toString(),maxContextTokens:1048576,maxOutputTokens:16384,inferenceCalls:0 as const}};
}

/** Revalidate the original material, candidate request identity and exact returned
 * evidence before allowing the v3 proof to authorize another runtime world.
 */
export async function verifySavedCoverageProbeEvidence(tx:DbTransaction,evidence:JsonObject,budgetId:string,requestDigest:string,content:string){
  const binding=SavedCoverageProbeBindingSchema.parse(evidence.sourceBinding),saved=await loadSavedCoverageRequest(tx,binding);
  const budget=coverageProbeBudget(budgetId,binding.stepId),request=coverageProbeRequest(saved,budget,0);
  if(saved.original.budget_id!==budgetId||evidence.operationId!==budget.reservationId||evidence.test!==GEMINI_SCHEMA_V3_PROOF||evidence.modelPolicy!==CANDIDATE_MODEL_POLICY||
    evidence.evidenceValidated!==true||evidence.originalOperationId!==saved.original.id||evidence.originalRequestDigest!==saved.original.request_digest||
    evidence.sourceInputDigest!==saved.sourceInputDigest||evidence.sourceSchemaDigest!==saved.sourceSchemaDigest||evidence.canonicalSchemaDigest!==saved.canonicalSchemaDigest||
    evidence.requestDigest!==requestDigest||providerRequestDigest(request,coverageRequestOptions(request))!==requestDigest)throw new Error("Coverage capability does not bind its actual source and request");
  const assessed=assessKnowledgeCoverageReview(parseStructuredOutput(content),request.untrustedInput);
  if(jsonDigest(assessed.review)!==evidence.resultDigest)throw new Error("Coverage capability result differs from its receipt");
  return assessed;
}

/** Operator-only single immutable attempt. Semantic course verdicts are never
 * committed by this probe; a failed review can still prove transport compatibility.
 */
export async function executeSavedCoverageProbe(binding:SavedCoverageProbeBinding,expectedRequestDigest:string){
  digest.parse(expectedRequestDigest);
  const prepared=await prepareSavedCoverageProbe(binding);
  if(prepared.report.candidateRequestDigest!==expectedRequestDigest)throw new Error("Prepared coverage request changed");
  const budget=new PostgresBudget(prepared.budgetId),world=process.env.VERCEL?"vercel":"local";
  const gate=new PersistedCapabilityGate(world,budget),rates=new OpenRouterRateCards();
  const model=new OpenRouterModel({apiKey:()=>process.env.OPENROUTER_API_KEY,budget,gate,rateCards:{async current(signal,policy){
    const rate=await rates.current(signal,policy);
    if(rate.contextTokens>prepared.report.maxContextTokens||worstCaseMicroUsd({contextTokens:rate.contextTokens,outputTokens:prepared.request.maxOutputTokens,
      inferencePasses:1,searches:0,priceCaps:candidatePolicy.priceCaps})>SAVED_COVERAGE_PROBE_MAX_MICRO_USD)throw new Error("Coverage endpoint exposure changed");
    return rate;
  }}});
  const result=await model.generateStructured(prepared.request,AbortSignal.timeout(executionTiming().stepMs));
  const assessed=assessKnowledgeCoverageReview(result.data,prepared.request.untrustedInput);
  const accounting=new OpenRouterAccounting(budget,()=>process.env.OPENROUTER_API_KEY);
  let target=await budget.reconciliationTarget(result.evidence.reservationId);
  if(target?.reservation.state!=="settled"){
    await accounting.reconcile(result.evidence.reservationId,AbortSignal.timeout(10000));target=await budget.reconciliationTarget(result.evidence.reservationId);
  }
  if(target?.reservation.state!=="settled")throw new Error("Coverage output is saved but accounting remains unknown; v3 is not activated");
  const proof:JsonObject={operationId:result.evidence.reservationId,modelPolicy:CANDIDATE_MODEL_POLICY,test:GEMINI_SCHEMA_V3_PROOF,
    credentialDigest:jsonDigest({credential:process.env.OPENROUTER_API_KEY??""}),sourceBinding:binding,
    sourceInputDigest:prepared.report.sourceInputDigest,sourceSchemaDigest:prepared.report.sourceSchemaDigest,canonicalSchemaDigest:prepared.report.canonicalSchemaDigest,
    originalOperationId:prepared.report.originalOperationId,originalRequestDigest:prepared.report.originalRequestDigest,
    requestDigest:prepared.report.candidateRequestDigest,resultDigest:jsonDigest(assessed.review),evidenceValidated:true};
  const savedContent=z.object({content:z.string()}).parse(target.receipt?.result).content;
  await readOnly(tx=>verifySavedCoverageProbeEvidence(tx,proof,prepared.budgetId,prepared.report.candidateRequestDigest,savedContent));
  await new PersistedCapabilityGate(world,budget,undefined,CANDIDATE_MODEL_POLICY).observe({capability:"model_structured",passed:true,
    testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:86400,instanceId:GEMINI_SCHEMA_V3_PROOF,evidence:proof});
  return {...prepared.report,settled:true,resultDigest:proof.resultDigest,reviewPassed:assessed.passed,courseStateChanged:false,inferenceCalls:result.evidence.replayed?0:1};
}
