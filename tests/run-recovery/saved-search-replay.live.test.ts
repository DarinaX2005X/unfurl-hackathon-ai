import {Client} from "pg";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {OpenRouterAccounting} from "../../src/server/ai/accounting";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import {OpenRouterResearch} from "../../src/server/research/openrouter";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import {AgentDecisionReceiptSchema} from "../../src/server/agent-tools/contracts";
import {agentToolStepInput} from "../../src/server/agent-tools/executor";
import {jsonDigest} from "../../src/server/ai/json";
import {reconcileSavedSearchBeforeRetry,resumeSavedAgentDecision} from "../../src/server/runs/receipt-resume";
import type {BudgetPort} from "../../src/server/budget/ports";

/** Reads the actual receipt; all settlement/replay writes are replaced by assertions. */
it.skipIf(!process.env.VERIFY_SAVED_SEARCH_RUN_ID)("verifies and replays the actual saved search without DB writes or network inference",async()=>{
  const url=new URL(process.env.DIRECT_DATABASE_URL!);for(const key of ["sslmode","sslrootcert","sslcert","sslkey"])url.searchParams.delete(key);
  const client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})}});
  await client.connect();try{
    await client.query("BEGIN READ ONLY");
    const job=(await client.query("SELECT id,retry_epoch FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1",[process.env.VERIFY_SAVED_SEARCH_RUN_ID])).rows[0];
    const step=(await client.query("SELECT * FROM unfurl.run_steps WHERE job_id=$1 AND step_key LIKE 'agent.v1:%:tool' AND status='failed'",[job.id])).rows[0];
    const decision=AgentDecisionReceiptSchema.parse((await client.query("SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2 AND status='succeeded'",[job.id,step.step_key.replace(/:tool$/,":decision")])).rows[0].result_reference);
    expect(decision.decision.tool).toBe("search");if(decision.decision.tool!=="search")throw new Error("Not a search");
    expect(step.input_digest).toBe(jsonDigest(agentToolStepInput(decision)));
    const logical=agentOperationId(step.id,"research_search",job.retry_epoch);
    const paid=(await client.query(`SELECT o.*,r.result,r.response_digest,r.reported_cost_usd,r.usage FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 AND o.logical_operation_id=$2`,[step.id,logical])).rows[0];
    expect(paid.id).toBe(stableExecutionId(logical,"attempt:1"));
    const before=jsonDigest(paid.result);
    const reservation={id:paid.id,budgetId:paid.budget_id,requestDigest:paid.request_digest,amountMicroUsd:String(paid.reserved_micro_usd),state:paid.state};
    const receipt={providerRequestId:paid.provider_request_id,responseDigest:paid.response_digest,reportedCostUsd:paid.reported_cost_usd,usage:paid.usage,result:paid.result};
    const reconcile=vi.fn(async()=>{}),halt=vi.fn(async()=>{}),network=vi.fn<typeof fetch>(async()=>{throw new Error("No provider network permitted");});
    const proof=await new OpenRouterAccounting({reconciliationTarget:async()=>({reservation,receipt,rateCard:paid.rate_card,purpose:paid.purpose}),reconcile,halt},()=>undefined,network)
      .reconcile(paid.id,new AbortController().signal,{nativeOnly:true});
    expect(proof).toMatchObject({settled:true,searchFeeVerified:true});
    expect(reconcile).toHaveBeenCalledWith(reservation,expect.objectContaining({finalCostMicroUsd:"10813"}));
    const recover=vi.fn(async(_context:unknown,digest:string)=>{expect(digest).toBe(paid.request_digest);return{reservation:{...reservation,state:"settled" as const},receipt};});
    const model=new OpenRouterModel({apiKey:()=>undefined,budget:{recover} as unknown as BudgetPort,fetcher:network,
      gate:{snapshot:()=>{throw new Error("No capabilities needed for replay");},assertAvailable:async()=>{throw new Error("No new call allowed");}},
      rateCards:{current:async()=>{throw new Error("No metadata needed for replay");}}});
    const result=await new OpenRouterResearch(model,{budget:{logicalOperationId:logical,reservationId:paid.id,runStepId:step.id,attempt:1,probe:false},deadlineAt:Date.now()+60000})
      .search(decision.decision.input,new AbortController().signal);
    expect(result.operationId).toBe(paid.id);expect(result.hits.length).toBeGreaterThan(0);
    expect(recover).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled();expect(halt).not.toHaveBeenCalled();expect(jsonDigest(paid.result)).toBe(before);
    const run=(await client.query("SELECT * FROM unfurl.agent_turn_runs WHERE id=$1",[process.env.VERIFY_SAVED_SEARCH_RUN_ID])).rows[0];
    const actor={id:run.owner_id,sessionId:"00000000-0000-4000-8000-000000000001",email:null};
    const deniedQuery=vi.fn(async(sql:string,parameters:unknown[])=>{
      expect(sql.startsWith("SELECT j.id,j.retry_epoch")).toBe(true);
      return client.query(sql.replace("FOR UPDATE OF j",""),parameters);
    });
    await reconcileSavedSearchBeforeRetry({query:deniedQuery} as never,{...actor,id:"00000000-0000-4000-8000-000000000001"},run.id);
    expect(deniedQuery).toHaveBeenCalledTimes(1);expect((await deniedQuery.mock.results[0]!.value).rows).toHaveLength(0);
    const writes:{sql:string;parameters:unknown[]}[]=[];
    let simulatedSettlement=false;
    const dryTx={query:async(sql:string,parameters:unknown[]=[])=>{
      if(/^(UPDATE|INSERT) /.test(sql)){
        writes.push({sql,parameters});
        if(sql.startsWith("UPDATE unfurl.ai_provider_operations SET state='settled'")){
          expect(parameters.slice(0,2)).toEqual([paid.id,"10813"]);simulatedSettlement=true;
        }
        return{rows:sql.includes("RETURNING last_seq")?[{last_seq:run.last_seq+1,updated_at:new Date()}]:[],rowCount:1};
      }
      expect(sql.startsWith("SELECT ")).toBe(true);
      const answer=await client.query(sql.replace(/ FOR (UPDATE|SHARE)( OF [a-z])?/g,""),parameters);
      if(sql.includes("o.state IN")&&simulatedSettlement)answer.rows=answer.rows.filter(row=>row.id!==paid.id);
      return answer;
    }};
    await reconcileSavedSearchBeforeRetry(dryTx as never,actor,run.id);
    expect(simulatedSettlement).toBe(true);expect(writes.some(({sql})=>sql.includes("UPDATE unfurl.run_steps"))).toBe(false);
    expect(await resumeSavedAgentDecision(dryTx as never,actor,run)).toBe(true);
    expect(writes.filter(({sql})=>sql.startsWith("UPDATE unfurl.run_steps")).map(({parameters})=>parameters)).toEqual([[step.id]]);
    expect(writes.some(({sql})=>sql.includes("advance_execution_job_retry")||sql.startsWith("INSERT INTO unfurl.agent_turn_runs"))).toBe(false);
    expect((await client.query("SELECT state FROM unfurl.ai_provider_operations WHERE id=$1",[paid.id])).rows[0].state).toBe(paid.state);
    await client.query("ROLLBACK");
  }finally{await client.end();}
},30000);
