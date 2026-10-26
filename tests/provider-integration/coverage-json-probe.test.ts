import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({saved:null as unknown}));
vi.mock("../../src/server/ai/saved-coverage-request",async importOriginal=>{
  const actual=await importOriginal<typeof import("../../src/server/ai/saved-coverage-request")>();
  return {...actual,loadSavedCoverageRequest:vi.fn(async()=>state.saved)};
});
import type {JsonObject} from "../../src/domain/common";
import {prepareSavedCoverageJsonProbe,coverageJsonProbeBudget,verifySavedCoverageJsonProbeEvidence,SAVED_COVERAGE_JSON_PROBE_MAX_MICRO_USD} from "../../src/server/ai/saved-coverage-json-probe";
import {coverageProbeBudget} from "../../src/server/ai/saved-coverage-probe";
import {coverageRequestOptions,coverageProbeRequest} from "../../src/server/ai/saved-coverage-request";
import {GEMINI_SCHEMA_V4_POLICY,GEMINI_SCHEMA_V2_POLICY,GEMINI_SCHEMA_V4_PROOF,modelPolicy} from "../../src/server/ai/model-policy";
import {providerRequestDigest} from "../../src/server/ai/openrouter";
import {jsonDigest} from "../../src/server/ai/json";
import {KnowledgeCoverageReviewSchema,createKnowledgeCoverageInput,KNOWLEDGE_COVERAGE_CATEGORIES} from "../../src/server/course-validation/knowledge";
import {fixture,id} from "../course-generation/fixtures";
import type {StructuredRequest} from "../../src/server/ai/ports";
import type {CapabilityTransaction} from "../../src/server/ai/capabilities";

afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
function preparedFixture(){
  const data=fixture(),knowledge=data.knowledge[0]!,binding={jobId:id(960),stepId:id(961)},budgetId=id(962);
  vi.stubEnv("AI_BUDGET_ID",budgetId);
  const material=createKnowledgeCoverageInput({draft:data.draft,knowledge,sourceKnowledgeStepId:id(963),outcomeId:knowledge.outcomes[0]!.outcomeId,facts:data.context,correction:null});
  const request:StructuredRequest<unknown>={operationId:id(964),purpose:"content_review",executionProfile:"longform_content",instructionVersion:"course-knowledge-coverage-v1",
    trustedInstructions:"Synthetic coverage proof only.",untrustedInput:material,schema:KnowledgeCoverageReviewSchema,schemaId:"synthetic_coverage",schemaVersion:3,
    model:modelPolicy(GEMINI_SCHEMA_V2_POLICY).model,modelPolicy:GEMINI_SCHEMA_V2_POLICY,maxOutputTokens:16384,deadlineAt:0,
    budget:{logicalOperationId:id(964),reservationId:id(965),attempt:1,runStepId:binding.stepId,probe:false}};
  const options=coverageRequestOptions(request),original={id:id(965),budget_id:budgetId,request_digest:providerRequestDigest(request,options),state:"unknown",reserved_micro_usd:"847872",provider_request_id:null};
  const saved={request,options,original,sourceKnowledgeStepId:id(963),sourceInputDigest:jsonDigest(material),sourceSchemaDigest:"a".repeat(64),canonicalSchemaDigest:jsonDigest(options.schema)};
  state.saved=saved;
  const review={knowledgeDigest:(material as JsonObject).knowledgeDigest,outcomeId:knowledge.outcomes[0]!.outcomeId,publicCommentary:null,
    checks:KNOWLEDGE_COVERAGE_CATEGORIES.map(category=>({category,status:"failed" as const,explanation:"Synthetic missing competence.",correction:"Research the full requirement.",evidence:[
      {path:["approvedOutcome","demonstration"],value:data.draft.outcomes[0]!.demonstration},{path:["knowledge"],value:knowledge}]})),invalidCriteria:[],unsupportedClaimIds:[]};
  const budget=coverageJsonProbeBudget(budgetId,binding.stepId),candidate=coverageProbeRequest(saved as never,budget,0,GEMINI_SCHEMA_V4_POLICY),requestDigest=providerRequestDigest(candidate,coverageRequestOptions(candidate));
  const proof:JsonObject={operationId:budget.reservationId,modelPolicy:GEMINI_SCHEMA_V4_POLICY,test:GEMINI_SCHEMA_V4_PROOF,sourceBinding:binding,
    sourceKnowledgeStepId:saved.sourceKnowledgeStepId,wireSchema:"gemini-recursive-json-mode-v4",responseFormat:"json_object",settled:true,responseDigest:"b".repeat(64),
    originalOperationId:original.id,originalRequestDigest:original.request_digest,sourceInputDigest:saved.sourceInputDigest,sourceSchemaDigest:saved.sourceSchemaDigest,
    canonicalSchemaDigest:saved.canonicalSchemaDigest,requestDigest,resultDigest:jsonDigest(review),evidenceValidated:true};
  const query=vi.fn(async()=>{throw new Error("No query expected outside the read-only source repository");}),tx={query},run:CapabilityTransaction=work=>work(tx as never);
  return {binding,budgetId,saved,review,proof,requestDigest,query,tx,run};
}

describe("single actual-source JSON mode coverage probe",()=>{
  it("prepares one stable attempt without inference, reservations or changes to the original unknown hold",async()=>{
    const h=preparedFixture(),before=structuredClone(h.saved.original),fetcher=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("provider calls forbidden"));
    const first=await prepareSavedCoverageJsonProbe(h.binding,h.run),second=await prepareSavedCoverageJsonProbe(h.binding,h.run);
    expect(first.report).toEqual(second.report);expect(first.report).toMatchObject({candidateRequestDigest:h.requestDigest,maxPaidCalls:1,maxExposureMicroUsd:"847872",inferenceCalls:0,originalFinancialState:"unknown",originalRetainedMicroUsd:"847872"});
    expect(first.request.budget).toMatchObject({attempt:1,runStepId:null,probe:true});expect(first.request.maxOutputTokens).toBe(16384);
    expect(first.report).toMatchObject({modelPolicy:GEMINI_SCHEMA_V4_POLICY,responseFormat:"json_object",wireSchema:"gemini-recursive-json-mode-v4"});
    expect(first.request.budget.reservationId).not.toBe(coverageProbeBudget(h.budgetId,h.binding.stepId).reservationId);
    expect(SAVED_COVERAGE_JSON_PROBE_MAX_MICRO_USD).toBe(847872n);expect(h.saved.original).toEqual(before);expect(fetcher).not.toHaveBeenCalled();expect(h.query).not.toHaveBeenCalled();
  });
  it("rejects another campaign and larger exposure before any provider traffic",async()=>{
    const h=preparedFixture();vi.stubEnv("AI_BUDGET_ID",id(999));await expect(prepareSavedCoverageJsonProbe(h.binding,h.run)).rejects.toThrow("another campaign");
    vi.stubEnv("AI_BUDGET_ID",h.budgetId);h.saved.request.maxOutputTokens=32768;await expect(prepareSavedCoverageJsonProbe(h.binding,h.run)).rejects.toThrow("allocation");
    expect(h.query).not.toHaveBeenCalled();
  });
  it("proves transport with an honestly failed coverage verdict while revalidating full object evidence",async()=>{
    const h=preparedFixture();await expect(verifySavedCoverageJsonProbeEvidence(h.tx as never,h.proof,h.budgetId,h.requestDigest,JSON.stringify(h.review),"b".repeat(64))).resolves.toMatchObject({passed:false});
  });
  it.each(["operationId","modelPolicy","test","sourceKnowledgeStepId","sourceInputDigest","sourceSchemaDigest","canonicalSchemaDigest","originalOperationId","originalRequestDigest","requestDigest","resultDigest","responseDigest","wireSchema","responseFormat","settled"])("rejects a forged %s capability binding",async field=>{
    const h=preparedFixture();h.proof[field]="different";
    await expect(verifySavedCoverageJsonProbeEvidence(h.tx as never,h.proof,h.budgetId,h.requestDigest,JSON.stringify(h.review),"b".repeat(64))).rejects.toThrow();
  });
  it("rejects missing evidence and path/value forgery despite valid provider JSON",async()=>{
    const h=preparedFixture();const review=structuredClone(h.review) as unknown as {checks:{evidence:{path:string[];value?:unknown}[]}[]};
    delete review.checks[0]!.evidence[0]!.value;h.proof.resultDigest=jsonDigest(review);
    await expect(verifySavedCoverageJsonProbeEvidence(h.tx as never,h.proof,h.budgetId,h.requestDigest,JSON.stringify(review),"b".repeat(64))).rejects.toThrow();
    const forged=structuredClone(h.review);forged.checks[0]!.evidence[0]!.path=["invented"];h.proof.resultDigest=jsonDigest(forged);
    await expect(verifySavedCoverageJsonProbeEvidence(h.tx as never,h.proof,h.budgetId,h.requestDigest,JSON.stringify(forged),"b".repeat(64))).rejects.toThrow();
  });
});
