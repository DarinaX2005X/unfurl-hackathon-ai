import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { fundingForActor, FUNDING_VERSION, resolveOperationFunding } from "../../src/server/budget/funding";
import { canReserve } from "../../src/server/budget/calculations";
import { ScopedRuntimeModel } from "../../src/server/ai/scoped-runtime-model";
import type { OpenRouterModel } from "../../src/server/ai/openrouter";
import type { DbTransaction } from "../../src/server/db";
import type { TextRequest } from "../../src/server/ai/ports";

const verification=randomUUID(),site=randomUUID();
const VERIFICATION_ACTOR_ID=randomUUID();
const config={version:FUNDING_VERSION,verification_budget_id:verification,site_budget_id:site,verification_actor_id:VERIFICATION_ACTOR_ID};
afterEach(()=>vi.unstubAllEnvs());
describe("funding isolation",()=>{
  it("routes MAIN to the same verification ledger and ordinary actors to site",()=>{
    vi.stubEnv("AI_BUDGET_ID",verification);
    expect(fundingForActor(config,VERIFICATION_ACTOR_ID)).toEqual({budgetId:verification,kind:"verification"});
    expect(fundingForActor(config,randomUUID())).toEqual({budgetId:site,kind:"site"});
    expect(fundingForActor(null,randomUUID())).toEqual({budgetId:verification,kind:"verification"});
  });
  it("keeps verification limits, uncaps site accounting, but never allows site probes or halted spend",()=>{
    const state={settled:20_000_000n,reserved:4_000_000n,probeSettled:0n,probeReserved:0n,halted:false};
    expect(canReserve({...state,kind:"verification"},1n,false).allowed).toBe(false);
    expect(canReserve({...state,kind:"site"},50_000_000n,false).allowed).toBe(true);
    expect(canReserve({...state,kind:"site"},1n,true).allowed).toBe(false);
    expect(canReserve({...state,kind:"site",halted:true},1n,false).allowed).toBe(false);
  });
  it("keeps probes on verification and rejects forged unbound ordinary calls",async()=>{
    vi.stubEnv("AI_BUDGET_ID",verification);
    const tx={query:vi.fn()} as unknown as DbTransaction;
    const base={reservationId:randomUUID(),logicalOperationId:randomUUID(),attempt:1,runStepId:null,probe:true};
    expect(await resolveOperationFunding(tx,base)).toEqual({budgetId:verification,kind:"verification"});
    await expect(resolveOperationFunding(tx,{...base,probe:false})).rejects.toMatchObject({code:"unavailable"});
    await expect(resolveOperationFunding(tx,{...base,runStepId:randomUUID()})).rejects.toMatchObject({code:"unavailable"});
    expect(tx.query).not.toHaveBeenCalled();
  });
  it("selects independent transports for concurrent site/verification calls and retries",async()=>{
    const seen:string[]=[];
    const modelForBudget=(id:string)=>({complete:async(input:TextRequest)=>{await Promise.resolve();seen.push(`${id}:${input.operationId}`);return id;}} as unknown as OpenRouterModel);
    const model=new ScopedRuntimeModel(modelForBudget,()=>({}) as never,async context=>({budgetId:context.probe?verification:site,kind:context.probe?"verification":"site"}));
    const request=(probe:boolean)=>({operationId:probe?"probe":"ordinary",budget:{probe}} as TextRequest);
    const signal=new AbortController().signal;
    expect(await Promise.all([model.complete(request(false),signal),model.complete(request(true),signal),model.complete(request(false),signal)])).toEqual([site,verification,site]);
    expect(seen).toEqual([`${site}:ordinary`,`${verification}:probe`,`${site}:ordinary`]);
  });
});
