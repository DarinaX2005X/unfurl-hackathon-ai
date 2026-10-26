import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {jsonDigest} from "../../src/server/ai/json";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({query:vi.fn(),resume:true,run:{} as Record<string,unknown>,snapshot:vi.fn(),enqueue:vi.fn()}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_purpose:unknown,work:(tx:unknown)=>Promise<unknown>)=>work({query:state.query})}));
vi.mock("../../src/server/idempotency",()=>({executeIdempotentInTransaction:async(_tx:unknown,_actor:unknown,_input:unknown,work:()=>Promise<unknown>)=>work()}));
vi.mock("../../src/server/runs/receipt-resume",()=>({reconcileSavedSearchBeforeRetry:async()=>{},resumeSavedAgentDecision:async()=>state.resume}));
vi.mock("../../src/server/runs/composition",()=>({getRuntimeAdmission:()=>({assertAvailable:async()=>{}})}));
vi.mock("../../src/server/runs/observer",()=>({requireObservedRun:async()=>state.run,readRunSnapshot:(...args:unknown[])=>state.snapshot(...args)}));
vi.mock("../../src/server/runs/enqueue",()=>({enqueueAcceptedRun:(...args:unknown[])=>state.enqueue(...args)}));
import {retryRun} from "../../src/server/runs/retry";
import {FUNDING_VERSION} from "../../src/server/budget/funding";

const verification=randomUUID(),site=randomUUID(),verificationActor=randomUUID(),ordinaryActor=randomUUID();
const config={version:FUNDING_VERSION,verification_budget_id:verification,site_budget_id:site,verification_actor_id:verificationActor};
interface Job {id:string;actor_id:string;agent_turn_run_id:string;generation_run_id:null;evaluation_id:null;target_evaluation_revision:null;activity_action_id:null;funding_version:string|null}

describe("public agent retry funding admission",()=>{
  let oldRun:string,oldJob:Job,nextJob:Job|undefined,actorId:string,checked:string[],halted:boolean,missingJob:boolean;
  const rows=(values:unknown[])=>({rows:values,rowCount:values.length});
  function makeJob(runId:string,legacy=false):Job{return{id:randomUUID(),actor_id:actorId,agent_turn_run_id:runId,generation_run_id:null,evaluation_id:null,target_evaluation_revision:null,activity_action_id:null,funding_version:legacy?null:FUNDING_VERSION};}
  beforeEach(()=>{
    vi.stubEnv("AI_BUDGET_ID",verification);state.resume=true;actorId=ordinaryActor;oldRun=randomUUID();oldJob=makeJob(oldRun);nextJob=undefined;checked=[];halted=false;missingJob=false;
    const conversation=randomUUID(),branch=randomUUID(),message=randomUUID();
    state.run={id:oldRun,owner_id:actorId,conversation_id:conversation,branch_id:branch,input_message_id:message,status:"failed"};
    state.enqueue.mockImplementation(async(_tx:unknown,input:{runId:string})=>{nextJob=makeJob(input.runId);return {jobId:nextJob.id};});
    state.snapshot.mockImplementation(async(_tx:unknown,_actor:unknown,id:string)=>({run:{id,ownerId:actorId,conversationId:conversation,branchId:branch,inputMessageId:message,status:"queued",lastSeq:0,error:null,createdAt:"2026-10-26T00:00:00.000Z",updatedAt:"2026-10-26T00:00:00.000Z"},messages:[],artifacts:[],lastSeq:0,retainedActionEvents:[]}));
    state.query.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes("NULL::uuid AS course_id"))return rows([{course_id:null,conversation_id:conversation}]);
      if(sql.startsWith("SELECT r.id FROM unfurl.agent_turn_runs"))return rows([{id:oldRun}]);
      if(sql.startsWith("SELECT active_branch_id"))return rows([{active_branch_id:branch}]);
      if(sql.includes("ORDER BY created_at DESC,id DESC LIMIT 1"))return rows([{id:oldRun}]);
      if(sql.includes("FROM unfurl.course_language_revision_intents")||sql.includes("FROM unfurl.curriculum_patch_intents"))return rows([]);
      if(sql.startsWith("INSERT INTO unfurl.agent_turn_runs"))return rows([]);
      if(sql==="SELECT id FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1"){
        const job=[oldJob,nextJob].find(job=>job?.agent_turn_run_id===values?.[0]);return rows(!missingJob&&job?[{id:job.id}]:[]);
      }
      if(sql.startsWith("SELECT j.id,j.agent_turn_run_id"))return rows([oldJob,nextJob].filter(job=>job?.id===values?.[0]));
      if(sql.startsWith("SELECT actor_id,budget_id,kind,target_digest,version")){
        const job=[oldJob,nextJob].find(job=>job?.id===values?.[0]);
        if(!job?.funding_version)return rows([]);
        const verificationFunded=job.actor_id===verificationActor;
        return rows([{actor_id:job.actor_id,budget_id:verificationFunded?verification:site,kind:verificationFunded?"verification":"site",version:FUNDING_VERSION,
          target_digest:jsonDigest({jobId:job.id,actorId:job.actor_id,agentTurnRunId:job.agent_turn_run_id,generationRunId:null,evaluationId:null,targetEvaluationRevision:null,activityActionId:null})}]);
      }
      if(sql.includes("FROM unfurl.ai_funding_configuration"))return rows([config]);
      if(sql.includes("FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE")){
        const id=String(values?.[0]);checked.push(id);return rows([{id,kind:id===site?"site":"verification",settled_micro_usd:id===site?"22000000":"19500000",reserved_micro_usd:"0",halted:id===verification&&halted}]);
      }
      if(sql.includes("AS probe_settled"))return rows([{probe_settled:"0",probe_reserved:"0"}]);
      throw new Error(`Unexpected retry query: ${sql.slice(0,100)}`);
    });
  });
  afterEach(()=>vi.unstubAllEnvs());
  const retry=()=>retryRun({id:actorId,sessionId:randomUUID(),email:null},oldRun,"agent_turn",randomUUID());
  it.each([false,true])("admits a new ordinary retry when verification is exhausted (halted=%s)",async halt=>{
    state.resume=false;halted=halt;oldJob=makeJob(oldRun,true);
    const result=await retry();expect(result.data.run.id).not.toBe(oldRun);expect(checked).toEqual([site]);
  });
  it("uses site funding when receipt recovery returns the same site-funded run",async()=>{
    halted=true;expect((await retry()).data.run.id).toBe(oldRun);expect(checked).toEqual([site]);
  });
  it("retains verification admission for receipt recovery on an ordinary actor's legacy run",async()=>{
    oldJob=makeJob(oldRun,true);
    await expect(retry()).rejects.toMatchObject({code:"budget_exhausted"});expect(checked).toEqual([verification]);
  });
  it("keeps a new MAIN retry within verification rather than the site ledger",async()=>{
    state.resume=false;actorId=verificationActor;state.run.owner_id=actorId;oldJob=makeJob(oldRun);
    await expect(retry()).rejects.toMatchObject({code:"budget_exhausted"});expect(checked).toEqual([verification]);
  });
  it("fails closed if the returned run has no persisted job",async()=>{
    missingJob=true;await expect(retry()).rejects.toMatchObject({status:503});expect(checked).toEqual([]);
  });
});
