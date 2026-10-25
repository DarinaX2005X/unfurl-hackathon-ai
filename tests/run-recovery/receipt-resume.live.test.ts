import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi,type Mock} from "vitest";
import {z} from "zod";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({client:null as Client|null}));
vi.mock("../../src/server/db",()=>({withSystemTransaction:async(_kind:unknown,work:(tx:Client)=>Promise<unknown>)=>{
  const client=state.client!;await client.query("SAVEPOINT route_transaction");
  try{const result=await work(client);await client.query("RELEASE SAVEPOINT route_transaction");return result;}
  catch(error){await client.query("ROLLBACK TO SAVEPOINT route_transaction");await client.query("RELEASE SAVEPOINT route_transaction");throw error;}
}}));
vi.mock("../../src/server/runs/composition",()=>({getRuntimeAdmission:()=>({assertAvailable:async()=>{}})}));
import {retryRun} from "../../src/server/runs/retry";
import {enqueueAcceptedRun} from "../../src/server/runs/enqueue";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import {readAgentDecisionRetryPolicy} from "../../src/server/runs/decision-policy";
import {ProviderFailure} from "../../src/server/ai/failure";
import {jsonDigest} from "../../src/server/ai/json";
import {PostgresBudget} from "../../src/server/budget/postgres";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import {approveEndpoint} from "../../src/server/ai/rate-card";
import {MODEL_ID,PROVIDER_TAG} from "../../src/server/ai/constants";
import {DurableRunExecutor} from "../../src/server/runs/executor";
import {RunHandlerRegistry} from "../../src/server/runs/registry";
import {appendChatEvent} from "../../src/server/runs/events";
import type {Actor} from "../../src/server/auth/actor";
import type {ModelRequestBase} from "../../src/server/ai/ports";

describe.skipIf(process.env.RUN_LIVE_RECEIPT_RESUME!=="1")("ordinary receipt-only retry (actual DB, rollback fixtures, simulated provider)",()=>{
  let client:Client,actor:Actor,run:string,job:string,step:string,conversation:string,branch:string,message:string;
  let model:OpenRouterModel,request:ModelRequestBase,fetcher:Mock<typeof fetch>;
  const input={saved:"exact immutable capture"},key="agent.v1:000000:decision";
  const digests={schema:"a".repeat(64),capability:"b".repeat(64),validationPolicy:"c".repeat(64),approval:null};
  beforeAll(async()=>{
    const url=new URL(process.env.DIRECT_DATABASE_URL!);for(const name of ["sslmode","sslrootcert","sslcert","sslkey"])url.searchParams.delete(name);
    client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})}});
    await client.connect();state.client=client;
  });
  beforeEach(async()=>{
    await client.query("BEGIN");await client.query("SET LOCAL ROLE service_role");
    actor={id:(await client.query("SELECT id FROM unfurl.profiles ORDER BY created_at LIMIT 1")).rows[0].id,sessionId:randomUUID(),email:null};
    conversation=randomUUID();branch=randomUUID();message=randomUUID();run=randomUUID();
    await client.query("INSERT INTO unfurl.conversations(id,owner_id,title,active_branch_id) VALUES($1,$2,'Rollback receipt resume',$3)",[conversation,actor.id,branch]);
    await client.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)",[branch,conversation]);
    await client.query("INSERT INTO unfurl.composer_drafts(conversation_id,text,pending_messages) VALUES($1,'','[]')",[conversation]);
    await client.query("INSERT INTO unfurl.messages(id,conversation_id,branch_id,role,status,parts,client_request_id) VALUES($1,$2,$3,'user','complete',$4,$5)",[message,conversation,branch,JSON.stringify([{type:"text",text:"Rollback fixture"}]),randomUUID()]);
    await client.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status) VALUES($1,$2,$3,$4,$5,'queued')",[run,actor.id,conversation,branch,message]);
    job=(await enqueueAcceptedRun(client,{kind:"agent_turn",runId:run})).jobId;step=stableExecutionId(job,key);
    for(const stage of ["capture","decision"]){
      await client.query(`INSERT INTO unfurl.run_steps(id,job_id,step_key,input_digest,schema_digest,capability_digest,validation_policy_digest,status,result_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[stage==="decision"?step:randomUUID(),job,`agent.v1:000000:${stage}`,jsonDigest(input),digests.schema,digests.capability,digests.validationPolicy,stage==="capture"?"succeeded":"failed",stage==="capture"?JSON.stringify(input):null]);
    }
    const rate=approveEndpoint({data:{endpoints:[{name:"DigitalOcean | moonshotai/kimi-k2.6-20260420",model_id:MODEL_ID,provider_name:"DigitalOcean",tag:PROVIDER_TAG,
      context_length:262144,max_completion_tokens:235929,supported_parameters:["max_tokens","tools","tool_choice"],status:0,pricing:{prompt:"0.00000057",completion:"0.0000024"}}]}});
    const budget=new PostgresBudget(process.env.AI_BUDGET_ID!,work=>work(client));
    fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({id:`gen-${randomUUID()}`,model:MODEL_ID,provider:"DigitalOcean",choices:[{finish_reason:"stop",message:{content:'{"answer":"saved"}'}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,cost:0.0000354}})));
    model=new OpenRouterModel({apiKey:()=>"simulated",budget,gate:{snapshot:()=>({model:MODEL_ID,provider:PROVIDER_TAG,structured:true,text:true,search:true,rubric:true,limitations:[]}),assertAvailable:async()=>{}},rateCards:{current:async()=>rate},fetcher});
    const logical=stableExecutionId(step,"agent_decision");request={operationId:logical,purpose:"turn_planning",instructionVersion:"rollback-test-v1",trustedInstructions:"Return the requested JSON.",untrustedInput:input,model:MODEL_ID,maxOutputTokens:4096,deadlineAt:Date.now()+60000,
      budget:{logicalOperationId:logical,reservationId:stableExecutionId(logical,"attempt:1"),attempt:1,runStepId:step,probe:false}};
  },30000);
  async function markFailed(terminal=false){
    if(terminal)fetcher.mockResolvedValueOnce(new Response(JSON.stringify({id:`gen-${randomUUID()}`,model:MODEL_ID,provider:"DigitalOcean",
      choices:[{finish_reason:"length",message:{content:null}}],usage:{prompt_tokens:20,completion_tokens:4096,total_tokens:4116,completion_tokens_details:{reasoning_tokens:4096},cost:0.0098418}})));
    const pending=model.generateStructured({...request,schema:z.object({answer:z.string()}).strict(),schemaId:"answer",schemaVersion:1},new AbortController().signal);
    if(terminal)await expect(pending).rejects.toThrow("provider.invalid_output");else await pending;
    const fault={code:"service_unavailable" as const,messageKey:terminal?"generation.invalidResponse":"generation.timeout",requestId:randomUUID(),retryable:!terminal};
    await client.query("UPDATE unfurl.agent_turn_runs SET status='failed',error=$2 WHERE id=$1",[run,JSON.stringify(fault)]);
    await client.query("UPDATE unfurl.execution_jobs SET status='failed',safe_error=$2 WHERE id=$1",[job,JSON.stringify(fault)]);
    await appendChatEvent(client,{kind:"agent_turn",runId:run,ownerId:actor.id,conversationId:conversation,branchId:branch,inputMessageId:message},{type:"run.failed",error:fault});
  }
  afterEach(async()=>{await client.query("ROLLBACK");});afterAll(async()=>{await client?.end();});
  it("reuses run/job/step/paid identity through the ordinary idempotent retry and commits the receipt once",async()=>{
    await markFailed();
    const retryKey=randomUUID();const before=(await client.query("SELECT count(*)::int AS n FROM unfurl.ai_budget_entries WHERE operation_id=$1",[request.budget.reservationId])).rows[0];
    const first=await retryRun(actor,run,"agent_turn",retryKey),second=await retryRun(actor,run,"agent_turn",retryKey);
    expect(first.data.run.id).toBe(run);expect(second.data.run.id).toBe(run);expect(first.data.run.status).toBe("queued");
    expect((await client.query("SELECT retry_epoch,status FROM unfurl.execution_jobs WHERE id=$1",[job])).rows[0]).toEqual({retry_epoch:0,status:"queued"});
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.agent_turn_events WHERE run_id=$1 AND type='run.failed'",[run])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.outbox WHERE job_id=$1 AND operation='resume'",[job])).rows[0].n).toBe(1);
    let commits=0;const schema=z.object({answer:z.string()}).strict();
    const executor=new DurableRunExecutor(new RunHandlerRegistry([{kind:"agent_turn",version:"rollback-test",assertAuthority:async()=>{},advance:async context=>{
      await context.step({key,input,digests,executionProfile:"longform_curriculum",outputSchema:schema,resultSchema:schema,
        effect:async effect=>(await model.generateStructured({...request,executionProfile:"longform_curriculum",deadlineAt:effect.deadlineAt,schema,schemaId:"answer",schemaVersion:1},effect.signal)).data,
        commit:async(tx,output)=>{commits++;await context.completeTurn(tx,{status:"succeeded"});return output;}});return{status:"succeeded"};
    }}]),work=>work(client));
    expect(await executor.advance(job)).toEqual({status:"finished"});expect(await executor.advance(job)).toEqual({status:"finished"});
    expect(commits).toBe(1);expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await retryRun(actor,run,"agent_turn",retryKey)).data.run.status).toBe("succeeded");
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.ai_budget_entries WHERE operation_id=$1",[request.budget.reservationId])).rows[0]).toEqual(before);
  },30000);
  it("rejects foreign ownership, stale branch, newer run and every unresolved held state",async()=>{
    await markFailed();
    await expect(retryRun({...actor,id:randomUUID()},run,"agent_turn",randomUUID())).rejects.toMatchObject({status:404});
    await client.query("SAVEPOINT stale_branch");const replacement=randomUUID();await client.query("INSERT INTO unfurl.conversation_branches(id,conversation_id) VALUES($1,$2)",[replacement,conversation]);
    await client.query("UPDATE unfurl.conversations SET active_branch_id=$2 WHERE id=$1",[conversation,replacement]);
    await expect(retryRun(actor,run,"agent_turn",randomUUID())).rejects.toMatchObject({status:409});await client.query("ROLLBACK TO SAVEPOINT stale_branch");
    await client.query("SAVEPOINT newer_run");await client.query("INSERT INTO unfurl.agent_turn_runs(id,owner_id,conversation_id,branch_id,input_message_id,status,created_at) VALUES($1,$2,$3,$4,$5,'cancelled',now()+interval '1 second')",[randomUUID(),actor.id,conversation,branch,message]);
    await expect(retryRun(actor,run,"agent_turn",randomUUID())).rejects.toMatchObject({status:409});await client.query("ROLLBACK TO SAVEPOINT newer_run");
    await client.query("SAVEPOINT changed_capture");await client.query("UPDATE unfurl.run_steps SET input_digest=$2 WHERE id=$1",[step,"f".repeat(64)]);
    await expect(retryRun(actor,run,"agent_turn",randomUUID())).rejects.toMatchObject({status:409});await client.query("ROLLBACK TO SAVEPOINT changed_capture");
    const held=randomUUID();await client.query(`INSERT INTO unfurl.ai_provider_operations(id,budget_id,logical_operation_id,attempt,run_step_id,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
      SELECT $1,budget_id,$2,1,run_step_id,request_digest,purpose,'reserved',reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card FROM unfurl.ai_provider_operations WHERE id=$3`,[held,randomUUID(),request.budget.reservationId]);
    for(const status of ["reserved","dispatched","unknown"]){
      if(status!=="reserved")await client.query("UPDATE unfurl.ai_provider_operations SET state=$2,dispatched_at=coalesce(dispatched_at,now()) WHERE id=$1",[held,status]);
      await expect(retryRun(actor,run,"agent_turn",randomUUID())).rejects.toMatchObject({status:409});
    }
    expect((await client.query("SELECT status FROM unfurl.execution_jobs WHERE id=$1",[job])).rows[0].status).toBe("failed");expect(fetcher).toHaveBeenCalledTimes(1);
  },30000);
  it("audits one explicit terminal retry epoch, preserves prior work, then replays a good receipt at that same epoch",async()=>{
    await markFailed(true);const retryKey=randomUUID();
    const captureBefore=(await client.query("SELECT result_reference,input_digest FROM unfurl.run_steps WHERE job_id=$1 AND status='succeeded'",[job])).rows;
    expect((await retryRun(actor,run,"agent_turn",retryKey)).data.run.id).toBe(run);
    expect((await retryRun(actor,run,"agent_turn",retryKey)).data.run.id).toBe(run);
    expect((await client.query("SELECT retry_epoch FROM unfurl.execution_jobs WHERE id=$1",[job])).rows[0].retry_epoch).toBe(1);
    expect((await client.query("SELECT from_epoch,to_epoch,semantic_target FROM unfurl.execution_job_retry_receipts WHERE job_id=$1",[job])).rows)
      .toEqual([{from_epoch:0,to_epoch:1,semantic_target:{kind:"agent_turn",runId:run}}]);
    const retryBinding={jobId:job,runId:run,decisionStepId:step,retryEpoch:1,inputDigest:jsonDigest(input),schemaDigest:digests.schema};
    expect(await readAgentDecisionRetryPolicy(client,retryBinding)).toBe(32768);
    expect(await readAgentDecisionRetryPolicy(client,{...retryBinding,retryEpoch:0})).toBeNull();
    const logical=agentOperationId(step,"agent_decision",1);expect(logical).not.toBe(request.operationId);
    expect(agentOperationId(step,"agent_decision",0)).toBe(request.operationId);
    let commits=0,interrupt=true;const schema=z.object({answer:z.string()}).strict();
    const executor=new DurableRunExecutor(new RunHandlerRegistry([{kind:"agent_turn",version:"rollback-test",assertAuthority:async()=>{},advance:async context=>{
      await context.step({key,input,digests,executionProfile:"longform_curriculum",outputSchema:schema,resultSchema:schema,
        effect:async effect=>{const budget=effect.budgetOperation("agent_decision");expect(budget.logicalOperationId).toBe(logical);
          const allocation=await context.read(tx=>readAgentDecisionRetryPolicy(tx,{...retryBinding,retryEpoch:effect.stepFence.retryEpoch}));
          const result=await model.generateStructured({...request,operationId:budget.logicalOperationId,budget,maxOutputTokens:allocation??8192,executionProfile:"longform_curriculum",deadlineAt:effect.deadlineAt,schema,schemaId:"answer",schemaVersion:1},effect.signal);
          if(interrupt){interrupt=false;throw new ProviderFailure("timeout");}return result.data;},
        commit:async(tx,output)=>{commits++;await context.completeTurn(tx,{status:"succeeded"});return output;}});return{status:"succeeded"};
    }}]),work=>work(client));
    expect(await executor.advance(job)).toEqual({status:"finished"});expect(commits).toBe(0);expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await retryRun(actor,run,"agent_turn",randomUUID())).data.run.id).toBe(run);
    expect((await client.query("SELECT retry_epoch FROM unfurl.execution_jobs WHERE id=$1",[job])).rows[0].retry_epoch).toBe(1);
    expect(await executor.advance(job)).toEqual({status:"finished"});expect(commits).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.ai_provider_operations WHERE run_step_id=$1",[step])).rows[0].n).toBe(2);
    expect((await client.query("SELECT result_reference,input_digest FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2",[job,"agent.v1:000000:capture"])).rows).toEqual(captureBefore);
    expect((await client.query("SELECT count(*)::int AS n FROM unfurl.execution_job_retry_receipts WHERE job_id=$1",[job])).rows[0].n).toBe(1);
  },30000);
});
