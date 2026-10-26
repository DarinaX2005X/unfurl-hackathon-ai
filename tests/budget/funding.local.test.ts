import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import type { DbTransaction } from "../../src/server/db";
import { captureNewJobFunding,resolveOperationFunding } from "../../src/server/budget/funding";
import { PostgresBudget } from "../../src/server/budget/postgres";
import { jsonDigest } from "../../src/server/ai/json";
import type { ReserveRequest } from "../../src/server/budget/ports";
import { runStateRelativeLedgerProof } from "../../src/server/budget/ledger-proof";

const modulePath=process.env.BUDGET_LOCAL_PG_MODULE;
const VERIFICATION_ACTOR_ID=randomUUID();
interface Sql {exec(sql:string):Promise<unknown>;query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;close():Promise<void>}
describe.skipIf(!modulePath)("funding schema and real ledger (isolated PostgreSQL/WASM, no network)",()=>{
  let sql:Sql,tx:DbTransaction;
  let historical: unknown;
  const verification=randomUUID(),site=randomUUID(),actor=randomUUID(),legacyJob=randomUUID(),legacyStep=randomUUID();
  const legacyOwnJob=randomUUID();
  const historicalOperation=randomUUID();
  const history=()=>sql.query("SELECT row_to_json(o) AS operation,row_to_json(r) AS response,row_to_json(e) AS entry FROM unfurl.ai_provider_operations o LEFT JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id LEFT JOIN unfurl.ai_budget_entries e ON e.operation_id=o.id WHERE o.id=$1",[historicalOperation]);
  const budgets=()=>sql.query("SELECT id,kind,settled_micro_usd::text,reserved_micro_usd::text FROM unfurl.ai_budgets ORDER BY kind");
  async function atomic<T>(work:()=>Promise<T>){await sql.exec("BEGIN");try{const result=await work();await sql.exec("COMMIT");return result;}catch(error){await sql.exec("ROLLBACK");throw error;}}
  async function rejected(work:()=>Promise<unknown>){await sql.exec("SAVEPOINT rejection");try{await expect(work()).rejects.toThrow();}finally{await sql.exec("ROLLBACK TO SAVEPOINT rejection; RELEASE SAVEPOINT rejection");}}
  async function job(owner:string,kind="agent_turn") {
    const target=randomUUID(),id=randomUUID(),step=randomUUID();
    if(kind==="agent_turn"||kind==="generation")await sql.query(`INSERT INTO unfurl.${kind==="agent_turn"?"agent_turn_runs":"generation_runs"}(id,owner_id) VALUES($1,$2)`,[target,owner]);
    if(kind==="evaluation") {const attempt=randomUUID();await sql.query("INSERT INTO unfurl.attempts(id,learner_id) VALUES($1,$2)",[attempt,owner]);await sql.query("INSERT INTO unfurl.evaluations(id,attempt_id) VALUES($1,$2)",[target,attempt]);}
    if(kind==="activity_action") {const enrollment=randomUUID(),session=randomUUID();await sql.query("INSERT INTO unfurl.enrollments(id,learner_id) VALUES($1,$2)",[enrollment,owner]);await sql.query("INSERT INTO unfurl.activity_sessions(id,enrollment_id) VALUES($1,$2)",[session,enrollment]);await sql.query("INSERT INTO unfurl.activity_actions(id,activity_session_id) VALUES($1,$2)",[target,session]);}
    await sql.query(`INSERT INTO unfurl.execution_jobs(id,${kind==="agent_turn"?"agent_turn_run_id":kind==="generation"?"generation_run_id":kind==="evaluation"?"evaluation_id":"activity_action_id"}${kind==="evaluation"?",target_evaluation_revision":""}) VALUES($1,$2${kind==="evaluation"?",1":""})`,[id,target]);
    await captureNewJobFunding(tx,id);
    await sql.query("INSERT INTO unfurl.run_steps(id,job_id) VALUES($1,$2)",[step,id]);
    return {id,step};
  }
  function request(step:string|null,amount="1",probe=false):ReserveRequest {const rateCard={model:"moonshotai/kimi-k2.6",provider:"digitalocean",policyVersion:"kimi-digitalocean-v1"};return{reservationId:randomUUID(),logicalOperationId:randomUUID(),attempt:1,runStepId:step,probe,purpose:probe?"capability_probe":"curriculum",amountMicroUsd:amount,requestDigest:"a".repeat(64),rateCard,rateCardDigest:jsonDigest(rateCard)};}
  const ledger=(id:string)=>new PostgresBudget(id,work=>work(tx));
  beforeAll(async()=>{
    const runtime=await import(/* @vite-ignore */ pathToFileURL(modulePath!).href) as {PGlite:new(options:unknown)=>Sql};
    sql=new runtime.PGlite({parsers:{20:(value:string)=>value}});
    const migration=await readFile("supabase/migrations/202610250004_execution_and_budget.sql","utf8");
    await sql.exec(`CREATE ROLE service_role SUPERUSER;CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA unfurl;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE unfurl.execution_jobs(id uuid PRIMARY KEY,agent_turn_run_id uuid,generation_run_id uuid,evaluation_id uuid,target_evaluation_revision integer,activity_action_id uuid,created_at timestamptz default now());
      CREATE TABLE unfurl.run_steps(id uuid PRIMARY KEY,job_id uuid REFERENCES unfurl.execution_jobs(id),step_key text,input_digest text,schema_digest text,capability_digest text,validation_policy_digest text);
      CREATE TABLE unfurl.agent_turn_runs(id uuid PRIMARY KEY,owner_id uuid);CREATE TABLE unfurl.generation_runs(id uuid PRIMARY KEY,owner_id uuid);
      CREATE TABLE unfurl.attempts(id uuid PRIMARY KEY,learner_id uuid);CREATE TABLE unfurl.evaluations(id uuid PRIMARY KEY,attempt_id uuid);
      CREATE TABLE unfurl.enrollments(id uuid PRIMARY KEY,learner_id uuid);CREATE TABLE unfurl.activity_sessions(id uuid PRIMARY KEY,enrollment_id uuid);CREATE TABLE unfurl.activity_actions(id uuid PRIMARY KEY,activity_session_id uuid);
      ${migration.slice(migration.indexOf("create table unfurl.ai_budgets"))}
      CREATE TABLE unfurl.ai_provider_response_normalizations(operation_id uuid,normalizer_version text,response_digest text,evidence_digest text,native_usage jsonb,source_evidence jsonb);
      CREATE TABLE unfurl.ai_provider_terminal_http_400_receipts(operation_id uuid);
      CREATE TABLE unfurl.ai_provider_attempt_retirements(operation_id uuid,kind text,job_id uuid,from_epoch integer,actor_id uuid);
      CREATE TABLE unfurl.execution_job_retry_receipts(job_id uuid,from_epoch integer,actor_id uuid);`);
    await sql.query("INSERT INTO unfurl.ai_budgets(id,campaign_key,reserved_micro_usd) VALUES($1,'legacy',5000)",[verification]);
    await sql.query("INSERT INTO auth.users(id) VALUES($1)",[VERIFICATION_ACTOR_ID]);
    await sql.exec(await readFile("supabase/migrations/202610250026_total_campaign_budget.sql","utf8"));
    const oldTarget=randomUUID();await sql.query("INSERT INTO unfurl.agent_turn_runs VALUES($1,$2)",[oldTarget,actor]);
    await sql.query("INSERT INTO unfurl.execution_jobs(id,agent_turn_run_id) VALUES($1,$2)",[legacyJob,oldTarget]);await sql.query("INSERT INTO unfurl.run_steps(id,job_id) VALUES($1,$2)",[legacyStep,legacyJob]);
    const oldOwnTarget=randomUUID();await sql.query("INSERT INTO unfurl.agent_turn_runs VALUES($1,$2)",[oldOwnTarget,VERIFICATION_ACTOR_ID]);
    await sql.query("INSERT INTO unfurl.execution_jobs(id,agent_turn_run_id) VALUES($1,$2)",[legacyOwnJob,oldOwnTarget]);
    const old=request(legacyStep,"5000");
    await sql.query("INSERT INTO unfurl.ai_provider_operations(id,budget_id,logical_operation_id,attempt,run_step_id,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card,dispatched_at) VALUES($1,$2,$3,1,$4,$5,'curriculum','unknown',5000,$6,$7,$8,$9,now())",[historicalOperation,verification,old.logicalOperationId,legacyStep,old.requestDigest,old.rateCard.model,old.rateCard.provider,old.rateCardDigest,JSON.stringify(old.rateCard)]);
    await sql.query("INSERT INTO unfurl.ai_provider_responses(operation_id,response_digest,usage,result) VALUES($1,$2,'{}','{\"historical\":true}')",[historicalOperation,"b".repeat(64)]);
    await sql.query("INSERT INTO unfurl.ai_budget_entries(id,budget_id,operation_id,effect_key,kind,reserved_delta_micro_usd,settled_delta_micro_usd) VALUES($1,$2,$3,$4,'reserve',5000,0)",[randomUUID(),verification,historicalOperation,`${historicalOperation}:reserve`]);
    historical=await history();
    await sql.exec(await readFile("supabase/migrations/202610250029_execution_funding.sql","utf8"));
    vi.stubEnv("AI_BUDGET_ID",verification);
    tx={query:async(text:string,values?:unknown[])=>!values&&text.includes(";")?(await sql.exec(text) as unknown[]).at(-1):sql.query(text,values)} as DbTransaction;
    await sql.query("INSERT INTO unfurl.ai_budgets(id,campaign_key,kind,hard_limit_micro_usd,spendable_limit_micro_usd) VALUES($1,'site','site',NULL,NULL)",[site]);
    await sql.query("INSERT INTO unfurl.ai_funding_configuration VALUES(true,'actor-funding-v1',$1,$2,$3,now())",[verification,site,VERIFICATION_ACTOR_ID]);
  });
  afterAll(async()=>{vi.unstubAllEnvs();await sql?.close();});
  it("binds all four ordinary job kinds to site, MAIN to verification, and retains old-job funding",async()=>atomic(async()=>{
    for(const kind of ["agent_turn","generation","evaluation","activity_action"]){const created=await job(actor,kind);expect(await resolveOperationFunding(tx,request(created.step))).toEqual({budgetId:site,kind:"site"});}
    const own=await job(VERIFICATION_ACTOR_ID);expect(await resolveOperationFunding(tx,request(own.step))).toEqual({budgetId:verification,kind:"verification"});
    expect(await resolveOperationFunding(tx,request(legacyStep))).toEqual({budgetId:verification,kind:"verification"});
  }));
  it("reserves/settles over $20 on site while retaining verification counters and enforcing its boundary",async()=>atomic(async()=>{
    const ordinary=await job(actor),own=await job(VERIFICATION_ACTOR_ID),before=await budgets();
    const held=await ledger(site).reserve(request(ordinary.step,"25000000"));
    await ledger(site).claimDispatch(held);await ledger(site).recordResponse(held,{providerRequestId:"fixture",responseDigest:"b".repeat(64),reportedCostUsd:"22",usage:{},result:{fixture:true}},"22000000");
    const after=await budgets();expect(after.rows.find(row=>row.id===verification)).toEqual(before.rows.find(row=>row.id===verification));
    expect(after.rows.find(row=>row.id===site)).toMatchObject({settled_micro_usd:"22000000",reserved_micro_usd:"0"});
    await rejected(()=>ledger(verification).reserve(request(own.step,"19495001")));
    await rejected(()=>ledger(site).reserve(request(own.step)));
    await rejected(()=>ledger(site).reserve(request(null,"1",true)));
    await rejected(()=>ledger(site).reserve(request(legacyStep)));
  }));
  it("rejects missing bindings, mutation, legacy rebinding, step reassignment and altered MAIN config",async()=>{
    await expect(atomic(async()=>{await sql.query("INSERT INTO unfurl.execution_jobs(id,agent_turn_run_id) VALUES($1,$2)",[randomUUID(),randomUUID()]);})).rejects.toThrow("captured atomically");
    await atomic(async()=>{const own=await job(VERIFICATION_ACTOR_ID);
      await rejected(()=>sql.query("UPDATE unfurl.execution_job_funding SET budget_id=$2 WHERE job_id=$1",[own.id,site]));
      await rejected(()=>sql.query("UPDATE unfurl.execution_jobs SET funding_version=NULL WHERE id=$1",[own.id]));
      await rejected(()=>sql.query("UPDATE unfurl.run_steps SET job_id=$2 WHERE id=$1",[own.step,legacyJob]));
      await rejected(()=>captureNewJobFunding(tx,legacyJob));
      await rejected(()=>sql.query("UPDATE unfurl.ai_funding_configuration SET verification_actor_id=$1",[actor]));
      await rejected(()=>sql.query("UPDATE unfurl.ai_budgets SET kind='site',hard_limit_micro_usd=NULL,spendable_limit_micro_usd=NULL WHERE id=$1",[verification]));
    });
  });
  it("retains historical receipts/unknown holds and runs activated proof fixtures entirely under rollback",async()=>{
    const before=await sql.query("SELECT id FROM unfurl.run_steps ORDER BY id");
    const peer={query:async(text:string)=>{if(text.includes("FROM unfurl.ai_budgets")&&text.includes("FOR UPDATE"))throw Object.assign(new Error("simulated peer contention"),{code:"55P03"});return {rows:[],rowCount:0};}} as unknown as DbTransaction;
    const result=await runStateRelativeLedgerProof({budgetId:verification,primary:tx,peer,sourceHash:"a".repeat(64)});
    expect(result.caseRollbacks).toHaveLength(5);
    // Exercise the fallback on an actual pre-activation MAIN job too. Only narrow
    // selection to that fixture; funding resolution and SQL are still real.
    const legacyTx={query:(text:string,values?:unknown[])=>text.includes("WHERE COALESCE(t.owner_id,g.owner_id)=$1")
      ?tx.query(text.replace("WHERE COALESCE","WHERE j.id=$2 AND COALESCE"),[...values!,legacyOwnJob]):tx.query(text,values)} as DbTransaction;
    expect((await runStateRelativeLedgerProof({budgetId:verification,primary:legacyTx,peer,sourceHash:"a".repeat(64)})).caseRollbacks).toHaveLength(5);
    expect(await sql.query("SELECT id FROM unfurl.run_steps ORDER BY id")).toEqual(before);
    expect(await history()).toEqual(historical);
  },30000);
});
