import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createAgentTurnHandler,type AgentJournal} from "../../src/server/agent-turns/handler";
import {ContextSnapshotSchema} from "../../src/server/agent-turns/repository";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import {jsonDigest,parseStructuredOutput} from "../../src/server/ai/json";
import {MODEL_ID,PROVIDER_TAG} from "../../src/server/ai/constants";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import type {BudgetPort} from "../../src/server/budget/ports";
import type {AgentToolDependencies} from "../../src/server/agent-tools/executor";
import type {DurableStep,ExecutionTarget,RunContext,StepEffectContext} from "../../src/server/runs/ports";
import type {JsonValue} from "../../src/domain/common";

/** Explicit read-only compatibility check. No dispatch, domain commit or provider call is possible. */
it.skipIf(!process.env.VERIFY_SAVED_DECISION_RUN_ID)("replays an actual saved decision with its exact original wire digest",async()=>{
  const url=new URL(process.env.DIRECT_DATABASE_URL!);for(const key of ["sslmode","sslrootcert","sslcert","sslkey"])url.searchParams.delete(key);
  const client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})}});
  await client.connect();try{
    await client.query("BEGIN READ ONLY");
    const run=(await client.query("SELECT * FROM unfurl.agent_turn_runs WHERE id=$1",[process.env.VERIFY_SAVED_DECISION_RUN_ID])).rows[0];
    const job=(await client.query("SELECT id,retry_epoch FROM unfurl.execution_jobs WHERE agent_turn_run_id=$1",[run.id])).rows[0];
    const step=(await client.query("SELECT id,step_key,input_digest,schema_digest FROM unfurl.run_steps WHERE job_id=$1 AND status='failed' AND step_key LIKE 'agent.v1:%:decision'",[job.id])).rows[0];
    const captured=(await client.query("SELECT result_reference FROM unfurl.run_steps WHERE job_id=$1 AND step_key=$2 AND status='succeeded'",[job.id,step.step_key.replace(/:decision$/,":capture")])).rows[0].result_reference;
    const snapshot=ContextSnapshotSchema.parse(captured);expect(jsonDigest(snapshot)).toBe(step.input_digest);
    const logical=agentOperationId(step.id,"agent_decision",job.retry_epoch);
    const paid=(await client.query(`SELECT o.*,r.result,r.response_digest,r.reported_cost_usd,r.usage FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id WHERE o.run_step_id=$1 AND o.logical_operation_id=$2`,[step.id,logical])).rows[0];
    expect(paid.state).toBe("settled");const before=jsonDigest(paid.result);
    const recover=vi.fn(async(_context:unknown,requestDigest:string)=>{
      expect(requestDigest).toBe(paid.request_digest);
      return{reservation:{id:paid.id,budgetId:paid.budget_id,requestDigest:paid.request_digest,amountMicroUsd:String(paid.reserved_micro_usd),state:paid.state},
        receipt:{providerRequestId:paid.provider_request_id,responseDigest:paid.response_digest,reportedCostUsd:paid.reported_cost_usd,usage:paid.usage,result:paid.result}};
    });
    const fetcher=vi.fn<typeof fetch>(async()=>{throw new Error("No network permitted");});
    const model=new OpenRouterModel({apiKey:()=>undefined,budget:{recover} as unknown as BudgetPort,fetcher,
      gate:{snapshot:()=>({model:MODEL_ID,provider:PROVIDER_TAG,structured:true,text:true,search:true,rubric:true,limitations:[]}),assertAvailable:async()=>{throw new Error("No new capability check permitted");}},
      rateCards:{current:async()=>{throw new Error("No metadata request permitted");}}});
    const target:Extract<ExecutionTarget,{kind:"agent_turn"}>={kind:"agent_turn",runId:run.id,ownerId:run.owner_id,conversationId:run.conversation_id,branchId:run.branch_id,inputMessageId:run.input_message_id};
    const journal={position:async()=>({index:snapshot.index,stage:"decision"}),receipt:async()=>snapshot} as unknown as AgentJournal;
    let output:JsonValue=null;
    const effect:StepEffectContext={stepId:step.id,signal:new AbortController().signal,deadlineAt:Date.now()+270000,
      stepFence:{jobId:job.id,jobLeaseOwner:randomUUID(),jobFencingToken:"1",retryEpoch:job.retry_epoch,stepId:step.id,stepLeaseOwner:randomUUID(),stepFencingToken:"1"},
      budgetOperation:()=>({reservationId:stableExecutionId(logical,"attempt:1"),logicalOperationId:logical,attempt:1,runStepId:step.id,probe:false})};
    const context={claim:{jobId:job.id,retryEpoch:job.retry_epoch,target},read:async(reader:(tx:unknown,target:ExecutionTarget)=>Promise<unknown>)=>reader(null,target),
      step:async(spec:DurableStep<JsonValue,JsonValue,JsonValue>)=>{expect(spec.digests.schema).toBe(step.schema_digest);expect(jsonDigest(spec.input)).toBe(step.input_digest);output=await spec.effect(effect,spec.input);return output;}} as unknown as RunContext;
    const dependencies:AgentToolDependencies={model,researchForStep:()=>{throw new Error("Research must not run during saved decision replay");}};
    await createAgentTurnHandler(dependencies,{journal}).advance(context);
    expect(recover).toHaveBeenCalledTimes(1);expect(fetcher).not.toHaveBeenCalled();expect(jsonDigest(paid.result)).toBe(before);
    const original=parseStructuredOutput(paid.result.content) as {tool:string;input:{domainHints:string[]}};
    expect(output).toMatchObject({tool:"search",input:{domainHints:original.input.domainHints.map(domain=>domain.trim())}});
    await client.query("ROLLBACK");
  }finally{await client.end();}
},30000);
