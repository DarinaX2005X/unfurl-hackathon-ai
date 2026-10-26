import {randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {describe,expect,it,vi} from "vitest";

const operator=await import(/* @vite-ignore */ pathToFileURL(resolve("supabase/configure-ai-funding.mjs")).href);
const verification=randomUUID(),site=randomUUID(),actor=randomUUID(),ref="qgwptuprlhhiphpwncps";
const args=["--project-ref",ref,"--verification-budget-id",verification,"--site-budget-id",site,"--verification-actor-id",actor];
const env={AI_BUDGET_ID:verification,SUPABASE_PROJECT_REF:ref,NEXT_PUBLIC_SUPABASE_URL:`https://${ref}.supabase.co`,DIRECT_DATABASE_URL:`postgresql://postgres:unused@db.${ref}.supabase.co:5432/postgres`};
describe("funding activation operator",()=>{
  it("defaults to read-only preview and requires the exact project, original budget and MAIN actor",()=>{
    expect(operator.fundingOperatorInput(args,env)).toMatchObject({apply:false,verificationBudgetId:verification,siteBudgetId:site});
    expect(()=>operator.fundingOperatorInput(args,{...env,AI_BUDGET_ID:randomUUID()})).toThrow();
    expect(()=>operator.fundingOperatorInput(args.slice(0,-1).concat("invalid-actor"),env)).toThrow();
    expect(()=>operator.fundingOperatorInput(args,{...env,SUPABASE_PROJECT_REF:"a".repeat(20)})).toThrow();
    expect(()=>operator.fundingOperatorInput(args,{...env,DIRECT_DATABASE_URL:env.DIRECT_DATABASE_URL.replace("5432","6543")})).toThrow();
  });
  it.each([false,true])("is idempotent for an exact existing configuration (apply=%s)",async apply=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes("FROM auth.users"))return {rows:[{id:actor}]};
      if(sql.includes("FROM unfurl.ai_budgets WHERE id"))return {rows:[{id:verification,kind:"verification",hard_limit_micro_usd:"20000000",spendable_limit_micro_usd:"19500000",settled_micro_usd:"6041486",reserved_micro_usd:"3828212",halted:false}]};
      if(sql.includes("FROM unfurl.ai_funding_configuration"))return {rows:[{version:"actor-funding-v1",verification_budget_id:verification,site_budget_id:site,verification_actor_id:actor}]};
      if(sql.includes("FROM unfurl.ai_budgets WHERE kind"))return {rows:[{id:site,kind:"site",hard_limit_micro_usd:null,spendable_limit_micro_usd:null}]};
      if(sql.startsWith("SELECT pg_advisory")||sql.startsWith("LOCK TABLE"))return {rows:[]};
      throw new Error("Unexpected mutation");
    });
    expect(await operator.configureFunding({query},{...operator.fundingOperatorInput(args,env),apply})).toMatchObject({alreadyConfigured:true,historicalAccountingChanged:false});
    expect(query.mock.calls.some(([sql])=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });
});
