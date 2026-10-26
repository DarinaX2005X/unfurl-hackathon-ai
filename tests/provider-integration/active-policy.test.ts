import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_purpose:unknown,work:(tx:unknown)=>Promise<unknown>)=>work({query:state.query})}));
import {assertModelPolicyAvailable,readActiveModelPolicy} from "../../src/server/ai/active-policy";
import {CANDIDATE_MODEL_POLICY,GEMINI_SCHEMA_V2_POLICY,GEMINI_SCHEMA_V4_POLICY,candidatePolicy} from "../../src/server/ai/model-policy";
import {runtimeConfigurationDigest} from "../../src/server/ai/capabilities";
import {jsonDigest} from "../../src/server/ai/json";
import {OpenRouterModel,providerRequestDigest} from "../../src/server/ai/openrouter";
import type {DbTransaction} from "../../src/server/db";
import type {BudgetPort,ProviderResponseReceipt} from "../../src/server/budget/ports";
import type {ModelRequestBase,ProviderCapabilityGate} from "../../src/server/ai/ports";

const tx={query:state.query} as unknown as DbTransaction;
function proof(overrides:Record<string,unknown>={}){
  return {id:randomUUID(),configuration_digest:runtimeConfigurationDigest("local",CANDIDATE_MODEL_POLICY),
    credential_digest:jsonDigest({credential:"policy-test-key"}),rejected:false,expires_at:"2026-01-02T00:00:00.000Z",...overrides};
}
function selectV3(row:ReturnType<typeof proof>){
  state.query.mockImplementation(async(_sql:string,args:unknown[])=>({rows:args[1]===GEMINI_SCHEMA_V4_POLICY?[]:[row]}));
}
function input():ModelRequestBase{
  const operationId=randomUUID();return {operationId,model:candidatePolicy.model,modelPolicy:CANDIDATE_MODEL_POLICY,purpose:"curriculum",
    instructionVersion:"policy-test-v1",trustedInstructions:"Return the saved response.",untrustedInput:{example:true},maxOutputTokens:100,
    deadlineAt:Date.now()+60000,budget:{reservationId:randomUUID(),logicalOperationId:operationId,attempt:1,runStepId:null,probe:false}};
}
function replayHarness(recovered:boolean){
  const request=input();
  const receipt:ProviderResponseReceipt={providerRequestId:"gen-saved-policy-test",responseDigest:"a".repeat(64),reportedCostUsd:"0.000001",usage:{},
    result:{model:candidatePolicy.model,provider:candidatePolicy.providerName,content:"Saved answer",finishReason:"stop",receivedAt:"2026-01-01T00:00:00.000Z",
      failure:null,rateCardDigest:"b".repeat(64),usage:{promptTokens:1,completionTokens:1,totalTokens:2,reasoningTokens:null,cachedPromptTokens:null,searchRequests:0,costUsd:"0.000001"},annotations:[]}};
  const recover=vi.fn(async(_context:unknown,digest:string)=>{expect(digest).toBe(providerRequestDigest(request));return recovered?{
    reservation:{id:request.budget.reservationId,budgetId:"campaign",requestDigest:digest,amountMicroUsd:"100",state:"settled" as const},receipt}:null;});
  const budget={recover,recordProviderIdentity:vi.fn(async()=>{}),reserve:vi.fn()} as unknown as BudgetPort;
  const gate={assertAvailable:vi.fn(async()=>{}),snapshot:vi.fn()} as unknown as ProviderCapabilityGate;
  const rates={current:vi.fn(async()=>{throw new Error("fresh-price-check");})};
  const fetcher=vi.fn<typeof fetch>(async()=>{throw new Error("inference forbidden");});
  const policyCheck=vi.fn(assertModelPolicyAvailable);
  return {request,recover,budget,gate,rates,fetcher,policyCheck,model:new OpenRouterModel({apiKey:()=>"policy-test-key",budget,gate,rateCards:rates,fetcher,assertPolicy:policyCheck})};
}

beforeEach(()=>{
  state.query.mockReset();vi.stubEnv("VERCEL","");vi.stubEnv("OPENROUTER_API_KEY","policy-test-key");vi.stubEnv("AI_BUDGET_ID",randomUUID());
});
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});

describe("durable chosen model policy",()=>{
  it("selects v4 only from its distinct settled JSON-mode proof, with old uncaptured calls still on v2",async()=>{
    state.query.mockImplementation(async(_sql:string,args:unknown[])=>({rows:args[1]===GEMINI_SCHEMA_V4_POLICY?[]:[proof()]}));
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(GEMINI_SCHEMA_V4_POLICY,false)).rejects.toThrow("provider.unavailable");
    state.query.mockResolvedValue({rows:[proof({configuration_digest:runtimeConfigurationDigest("local",GEMINI_SCHEMA_V4_POLICY)})]});
    expect(await readActiveModelPolicy(tx)).toBe(GEMINI_SCHEMA_V4_POLICY);
    await expect(assertModelPolicyAvailable(GEMINI_SCHEMA_V4_POLICY,false)).resolves.toBeUndefined();
    expect(await readActiveModelPolicy(tx,{allowSchemaV3:false})).toBe(GEMINI_SCHEMA_V2_POLICY);
    const sql=state.query.mock.calls[0]![0] as string;expect(sql).toContain("proof.evidence->>'responseFormat'='json_object'");
    expect(sql).toContain("proof.evidence->>'responseDigest'=r.response_digest");expect(sql).toContain("o.state='settled'");
  });
  it("requires a distinct v3 proof while historical uncaptured requests retain v2 selection",async()=>{
    state.query.mockImplementation(async(_sql:string,args:unknown[])=>({rows:args[1]===GEMINI_SCHEMA_V2_POLICY?[proof({configuration_digest:runtimeConfigurationDigest("local",GEMINI_SCHEMA_V2_POLICY)})]:[]}));
    expect(await readActiveModelPolicy(tx)).toBe(GEMINI_SCHEMA_V2_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    await expect(assertModelPolicyAvailable(GEMINI_SCHEMA_V2_POLICY,false)).resolves.toBeUndefined();
    selectV3(proof());
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    expect(await readActiveModelPolicy(tx,{allowSchemaV3:false})).toBe(GEMINI_SCHEMA_V2_POLICY);
    const sql=state.query.mock.calls[0]![0] as string;expect(sql).toContain("o.rate_card->>'policyVersion'=$2");expect(sql).toContain("evidenceValidated");
  });
  it("uses the historical bootstrap only when there is no settled successful candidate selection",async()=>{
    state.query.mockResolvedValue({rows:[]});expect(await readActiveModelPolicy(tx)).toBe("kimi-digitalocean-v1");
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    const sql=state.query.mock.calls[0]![0] as string;
    expect(sql).toContain("o.state='settled'");expect(sql).toContain("proof.passed");expect(sql).toContain("r.result->'failure'='null'::jsonb");
  });
  it("keeps the same chosen route and availability across proof expiry without writing or buying a probe",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    selectV3(proof());
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).resolves.toBeUndefined();
    vi.setSystemTime(new Date("2026-01-03T12:00:00Z"));
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).resolves.toBeUndefined();
    for(const [sql]of state.query.mock.calls){expect(sql).toMatch(/^SELECT /);expect(sql).not.toContain("expires_at");}
  });
  it.each(["credential","configuration","rejection"])("retains the chosen route but explicitly rejects incompatible %s evidence",async reason=>{
    const row=proof();
    if(reason==="credential")row.credential_digest=jsonDigest({credential:"another-key"});
    if(reason==="configuration")row.configuration_digest="c".repeat(64);
    if(reason==="rejection")row.rejected=true;
    selectV3(row);
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
  });
  it("preserves legacy operation and explicitly bounded probe admission paths",async()=>{
    await expect(assertModelPolicyAvailable("kimi-digitalocean-v1",false)).resolves.toBeUndefined();
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,true)).resolves.toBeUndefined();
    expect(state.query).not.toHaveBeenCalled();
  });
  it("preserves campaign Gemini selection after hosting changes but requires target authorization",async()=>{
    vi.stubEnv("VERCEL","1");
    state.query.mockImplementation(async(_sql:string,args:unknown[])=>({rows:args[3]===true||args[1]===GEMINI_SCHEMA_V4_POLICY?[]:[proof()]}));
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    const queries=state.query.mock.calls;
    expect(queries[0]![1][3]).toBe(false);expect(queries[2]![1][3]).toBe(true);
    expect(queries[0]![0]).toContain("ELSE NOT(proof.evidence ? 'portability')");
  });
  it("anchors candidate rejection to original proof time rather than import time",async()=>{
    state.query.mockResolvedValue({rows:[]});await readActiveModelPolicy(tx);
    const sql=state.query.mock.calls[0]![0] as string;
    expect(sql).toContain("proof.evidence->'portability'->>'sourceObservedAt'");
    expect(sql).toContain("failed.result->>'provider'<>'Google AI Studio'");
  });
  it("replays a paid receipt before current compatibility, price, budget or network checks",async()=>{
    state.query.mockResolvedValue({rows:[proof({rejected:true})]});
    const h=replayHarness(true),result=await h.model.complete(h.request,new AbortController().signal);
    expect(result.content).toBe("Saved answer");expect(result.evidence.replayed).toBe(true);
    expect(h.policyCheck).not.toHaveBeenCalled();expect(h.gate.assertAvailable).not.toHaveBeenCalled();expect(h.rates.current).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();expect(state.query).not.toHaveBeenCalled();
  });
  it("still requires fresh price verification before a new paid call even when the selected proof is old",async()=>{
    selectV3(proof());const h=replayHarness(false);
    await expect(h.model.complete(h.request,new AbortController().signal)).rejects.toThrow("fresh-price-check");
    expect(h.policyCheck).toHaveBeenCalledWith(CANDIDATE_MODEL_POLICY,false);expect(h.gate.assertAvailable).toHaveBeenCalledTimes(1);
    expect(h.rates.current).toHaveBeenCalledTimes(1);expect(h.budget.reserve).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("does not bypass budget admission after separating it from durable model selection",async()=>{
    selectV3(proof());const h=replayHarness(false);
    vi.mocked(h.gate.assertAvailable).mockRejectedValueOnce(new Error("budget-exhausted"));
    await expect(h.model.complete(h.request,new AbortController().signal)).rejects.toThrow("budget-exhausted");
    expect(h.policyCheck).toHaveBeenCalledTimes(1);expect(h.rates.current).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();
  });
});
