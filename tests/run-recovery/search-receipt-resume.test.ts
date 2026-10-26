import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const ledger=vi.hoisted(()=>({target:null as unknown,settled:false,reconcile:vi.fn(),halt:vi.fn()}));
vi.mock("../../src/server/budget/postgres",()=>({PostgresBudget:class{
  async reconciliationTarget(){return ledger.target;}
  async reconcile(...args:unknown[]){ledger.settled=true;ledger.reconcile(...args);}
  halt=ledger.halt;
}}));
import {reconcileSavedSearchBeforeRetry,resumeSavedAgentDecision} from "../../src/server/runs/receipt-resume";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import {agentToolStepInput} from "../../src/server/agent-tools/executor";
import {jsonDigest} from "../../src/server/ai/json";
import type {GenerationRow} from "../../src/server/curricula/repository";

function fixture(){
  ledger.settled=false;ledger.reconcile.mockClear();ledger.halt.mockClear();
  const actor={id:randomUUID(),sessionId:randomUUID(),email:null},jobId=randomUUID();
  const run={id:randomUUID(),status:"failed",error:{messageKey:"generation.unavailable"},conversation_id:randomUUID(),branch_id:randomUUID(),input_message_id:randomUUID()} as GenerationRow;
  const stepKey="agent.v1:000000:tool",stepId=stableExecutionId(jobId,stepKey),logical=agentOperationId(stepId,"research_search",0);
  const capture={kind:"context",searchMemory:{searches:[]},planningPolicy:{version:"planner-8192-v1",maxOutputTokens:8192}};
  const decision={kind:"decision" as const,index:0,invocationId:stableExecutionId(run.id,"tool:0"),decision:{tool:"search" as const,input:{query:"AI foundations",language:"en",limit:5}},capturedDraft:null,capturedCourseRevision:null,preparationError:null};
  const step={id:stepId,step_key:stepKey,input_digest:jsonDigest(agentToolStepInput(decision)),schema_digest:jsonDigest({version:"agent-tool-output-v1"}),status:"failed"};
  const rate={contextTokens:262144,pricing:{prompt:"0.00000057",completion:"0.0000024",input_cache_read:"0.000000114"},search:{engine:"parallel",mode:"advanced",max_uses:1,maxToolCalls:1,inferencePasses:2}};
  const native={prompt_tokens:3971,completion_tokens:1576,total_tokens:5547,cost:"0.010812397999999999",prompt_tokens_details:{cached_tokens:512},
    cost_details:{upstream_inference_cost:"0.005812398"},server_tool_use_details:{web_search_requests:1,tool_calls_requested:1,tool_calls_executed:1}};
  const result={model:"moonshotai/kimi-k2.6",provider:"DigitalOcean",finishReason:"stop",failure:null,content:"Saved citations",rateCardDigest:jsonDigest(rate),nativeUsage:native,annotations:[{}]};
  const paid={id:stableExecutionId(logical,"attempt:1"),budget_id:randomUUID(),attempt:1,state:"unknown",purpose:"web_search",provider_request_id:"gen-original",response_provider_id:"gen-original",request_digest:"a".repeat(64),rate_card_digest:jsonDigest(rate),rate_card:rate,result};
  const target={reservation:{id:paid.id,budgetId:paid.budget_id,requestDigest:paid.request_digest,amountMicroUsd:"330224",state:"unknown"},rateCard:rate,purpose:"web_search",
    receipt:{providerRequestId:paid.provider_request_id,responseDigest:"b".repeat(64),reportedCostUsd:native.cost,usage:{searchRequests:1},result}};
  ledger.target=target;
  const controls={held:false,python:false,missingReceipt:false,wrongCapture:false};
  const query=vi.fn(async(sql:string,parameters:unknown[]=[])=>{
    if(sql.startsWith("SELECT id,status,retry_epoch"))return{rows:[{id:jobId,status:"failed",retry_epoch:0}]};
    if(sql.startsWith("SELECT j.id,j.retry_epoch")){expect(parameters).toEqual([run.id,actor.id]);return{rows:[{id:jobId,retry_epoch:0}]};}
    if(sql.includes("status<>'succeeded'"))return{rows:[step]};
    if(sql.includes("SELECT result_reference,input_digest"))return{rows:[{result_reference:decision,input_digest:controls.wrongCapture?"a".repeat(64):jsonDigest(capture)}]};
    if(sql.includes("SELECT result_reference"))return{rows:[{result_reference:capture}]};
    if(sql.includes("SELECT o.id,o.budget_id")){expect(parameters).toEqual([stepId,logical]);return{rows:controls.missingReceipt?[]:[paid]};}
    if(sql.includes("o.state IN"))return{rows:controls.held||!ledger.settled?[{id:randomUUID()}]:[]};
    if(sql.includes("FROM unfurl.code_execution_runs"))return{rows:controls.python?[{id:randomUUID()}]:[]};
    if(sql.includes("RETURNING last_seq"))return{rows:[{last_seq:6,updated_at:new Date()}]};
    return{rows:[],rowCount:1};
  });
  return{actor,run,jobId,step,query,paid,native,target,controls,capture,decision};
}
describe("ordinary retry of a saved native search receipt",()=>{
  it("reconciles before budget admission without resuming or creating work",async()=>{
    const h=fixture();
    await reconcileSavedSearchBeforeRetry({query:h.query} as never,h.actor,h.run.id);
    expect(ledger.reconcile).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE")||sql.startsWith("INSERT"))).toBe(false);
    // A subsequent admission sees only the other unresolved operation; ordinary retry
    // still performs its branch/intent guards and reuses the same idempotent proof.
    expect(ledger.settled).toBe(true);
  });
  it.each(["foreign owner","deleted conversation","stale branch","newer run"])("does not inspect receipts when the authoritative preflight excludes %s",async()=>{
    const h=fixture(),query=vi.fn(async(sql:string,parameters:unknown[])=>{
      expect(parameters).toEqual([h.run.id,h.actor.id]);
      expect(sql).toContain("r.owner_id=$2");expect(sql).toContain("c.deleted_at IS NULL");
      expect(sql).toContain("c.active_branch_id=r.branch_id");expect(sql).toContain("SELECT latest.id");
      return{rows:[]};
    });
    await reconcileSavedSearchBeforeRetry({query} as never,h.actor,h.run.id);
    expect(query).toHaveBeenCalledTimes(1);expect(ledger.reconcile).not.toHaveBeenCalled();
  });
  it("settles proven charge and queues only the same failed tool, preserving epoch and prior receipts",async()=>{
    const h=fixture(),before=JSON.stringify({capture:h.capture,decision:h.decision,receipt:h.target.receipt});
    expect(await resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run)).toBe(true);
    expect(ledger.reconcile).toHaveBeenCalledExactlyOnceWith(h.target.reservation,expect.objectContaining({providerRequestId:"gen-original",finalCostMicroUsd:"10813"}));
    expect(h.query.mock.calls.filter(([sql])=>sql.startsWith("UPDATE unfurl.run_steps")).map(([,params])=>params)).toEqual([[h.step.id]]);
    expect(h.query.mock.calls.find(([sql])=>sql.startsWith("UPDATE unfurl.execution_jobs"))?.[1]).toEqual([h.jobId]);
    expect(h.query.mock.calls.some(([sql])=>sql.includes("advance_execution_job_retry")||sql.startsWith("INSERT INTO unfurl.run_steps")||sql.startsWith("INSERT INTO unfurl.agent_turn_runs"))).toBe(false);
    expect(JSON.stringify({capture:h.capture,decision:h.decision,receipt:h.target.receipt})).toBe(before);
    expect(h.query.mock.calls.some(([sql])=>sql.includes("'resume'"))).toBe(true);
  });
  it.each(["missingReceipt","wrongCapture"] as const)("rejects %s without settlement or a new paid epoch",async key=>{
    const h=fixture();h.controls[key]=true;
    await expect(resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run)).rejects.toMatchObject({status:409});
    expect(ledger.reconcile).not.toHaveBeenCalled();expect(h.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE"))).toBe(false);
  });
  it.each(["unproven fee","wrong operation","wrong rate digest","incomplete response"])("retains holds for %s",async kind=>{
    const h=fixture();
    if(kind==="unproven fee")h.native.cost_details.upstream_inference_cost="0.004812398";
    if(kind==="wrong operation")h.paid.id=randomUUID();
    if(kind==="wrong rate digest")h.paid.rate_card_digest="c".repeat(64);
    if(kind==="incomplete response")h.paid.result.finishReason="length";
    await expect(resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run)).rejects.toMatchObject({status:409});
    expect(ledger.reconcile).not.toHaveBeenCalled();expect(h.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE"))).toBe(false);
  });
  it.each(["held","python"] as const)("does not requeue while another %s operation is unresolved",async key=>{
    const h=fixture();h.controls[key]=true;
    await expect(resumeSavedAgentDecision({query:h.query} as never,h.actor,h.run)).rejects.toMatchObject({status:409});
    // In the real public retry, this exception rolls the encompassing transaction back.
    expect(h.query.mock.calls.some(([sql])=>sql.startsWith("UPDATE"))).toBe(false);
  });
});
