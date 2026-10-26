import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_purpose:unknown,work:(tx:unknown)=>Promise<unknown>)=>work({query:state.query})}));
import {assertModelPolicyAvailable,readActiveModelPolicy} from "../../src/server/ai/active-policy";
import {CANDIDATE_MODEL_POLICY,candidatePolicy} from "../../src/server/ai/model-policy";
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
  it("uses the historical bootstrap only when there is no settled successful candidate selection",async()=>{
    state.query.mockResolvedValue({rows:[]});expect(await readActiveModelPolicy(tx)).toBe("kimi-digitalocean-v1");
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    const sql=state.query.mock.calls[0]![0] as string;
    expect(sql).toContain("o.state='settled'");expect(sql).toContain("proof.passed");expect(sql).toContain("r.result->'failure'='null'::jsonb");
  });
  it("keeps the same chosen route and availability across proof expiry without writing or buying a probe",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    state.query.mockResolvedValue({rows:[proof()]});
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
    state.query.mockResolvedValue({rows:[row]});
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,false)).rejects.toThrow("provider.unavailable");
    expect(await readActiveModelPolicy(tx)).toBe(CANDIDATE_MODEL_POLICY);
  });
  it("preserves legacy operation and explicitly bounded probe admission paths",async()=>{
    await expect(assertModelPolicyAvailable("kimi-digitalocean-v1",false)).resolves.toBeUndefined();
    await expect(assertModelPolicyAvailable(CANDIDATE_MODEL_POLICY,true)).resolves.toBeUndefined();
    expect(state.query).not.toHaveBeenCalled();
  });
  it("replays a paid receipt before current compatibility, price, budget or network checks",async()=>{
    state.query.mockResolvedValue({rows:[proof({rejected:true})]});
    const h=replayHarness(true),result=await h.model.complete(h.request,new AbortController().signal);
    expect(result.content).toBe("Saved answer");expect(result.evidence.replayed).toBe(true);
    expect(h.policyCheck).not.toHaveBeenCalled();expect(h.gate.assertAvailable).not.toHaveBeenCalled();expect(h.rates.current).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();expect(state.query).not.toHaveBeenCalled();
  });
  it("still requires fresh price verification before a new paid call even when the selected proof is old",async()=>{
    state.query.mockResolvedValue({rows:[proof()]});const h=replayHarness(false);
    await expect(h.model.complete(h.request,new AbortController().signal)).rejects.toThrow("fresh-price-check");
    expect(h.policyCheck).toHaveBeenCalledWith(CANDIDATE_MODEL_POLICY,false);expect(h.gate.assertAvailable).toHaveBeenCalledTimes(1);
    expect(h.rates.current).toHaveBeenCalledTimes(1);expect(h.budget.reserve).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("does not bypass budget admission after separating it from durable model selection",async()=>{
    state.query.mockResolvedValue({rows:[proof()]});const h=replayHarness(false);
    vi.mocked(h.gate.assertAvailable).mockRejectedValueOnce(new Error("budget-exhausted"));
    await expect(h.model.complete(h.request,new AbortController().signal)).rejects.toThrow("budget-exhausted");
    expect(h.policyCheck).toHaveBeenCalledTimes(1);expect(h.rates.current).not.toHaveBeenCalled();expect(h.fetcher).not.toHaveBeenCalled();
  });
});
