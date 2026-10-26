import {Client} from "pg";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {buildAgentDecisionRequest} from "../../src/server/agent-turns/handler";
import {ContextSnapshotSchema} from "../../src/server/agent-turns/repository";
import {OpenRouterModel} from "../../src/server/ai/openrouter";
import {jsonDigest} from "../../src/server/ai/json";
import {agentOperationId,stableExecutionId} from "../../src/server/runs/identity";
import {readAgentDecisionRetryPolicy,readAgentDecisionModelRetryPolicy} from "../../src/server/runs/decision-policy";
import {ModelPolicySchema} from "../../src/server/ai/model-policy";
import type {DbTransaction} from "../../src/server/db";
import type {BudgetPort} from "../../src/server/budget/ports";

it.skipIf(!process.env.VERIFY_PLANNER_RECEIPTS_RUN_ID)("replays saved legacy and current-run v3 planner receipts at their exact original request digests",async()=>{
  const url=new URL(process.env.DIRECT_DATABASE_URL!);for(const option of ["sslmode","sslrootcert","sslcert","sslkey"])url.searchParams.delete(option);
  const client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,...(process.env.DATABASE_SSL_CA?{ca:process.env.DATABASE_SSL_CA.replace(/\\n/g,"\n")}:{})}});
  await client.connect();try{
    await client.query("BEGIN READ ONLY");
    const rows=(await client.query(`SELECT DISTINCT ON (coalesce(c.result_reference->>'agentProtocol','legacy'),o.state)
      r.id AS run_id,r.owner_id,r.conversation_id,r.branch_id,r.input_message_id,j.id AS job_id,j.retry_epoch,
      s.id AS step_id,s.input_digest,s.schema_digest,c.result_reference AS captured,o.id AS operation_id,o.budget_id,o.logical_operation_id,
      o.request_digest,o.reserved_micro_usd::text,o.state,o.attempt,o.rate_card->>'policyVersion' AS operation_policy,
      p.provider_request_id,p.response_digest,p.reported_cost_usd,p.usage,p.result
      FROM unfurl.agent_turn_runs r JOIN unfurl.execution_jobs j ON j.agent_turn_run_id=r.id
      JOIN unfurl.run_steps s ON s.job_id=j.id AND s.step_key LIKE 'agent.v1:%:decision'
      JOIN unfurl.run_steps c ON c.job_id=j.id AND c.step_key=replace(s.step_key,':decision',':capture') AND c.status='succeeded'
      JOIN unfurl.ai_provider_operations o ON o.run_step_id=s.id
      LEFT JOIN unfurl.ai_provider_responses p ON p.operation_id=o.id
      WHERE r.id=$1 AND o.purpose='turn_planning' AND c.result_reference->'readerCapabilities' IS NULL
        AND ((o.state='settled' AND p.result->>'finishReason'='stop' AND p.result->>'failure' IS NULL)
          OR (o.state='unknown' AND p.operation_id IS NULL))
      ORDER BY coalesce(c.result_reference->>'agentProtocol','legacy'),o.state,o.created_at DESC`,[process.env.VERIFY_PLANNER_RECEIPTS_RUN_ID])).rows;
    expect(rows.some(row=>row.captured.agentProtocol==="conversational-v3")).toBe(true);
    expect(rows.some(row=>!row.captured.agentProtocol)).toBe(true);
    for(const row of rows){
      const snapshot=ContextSnapshotSchema.parse(row.captured),original=jsonDigest(row.captured);
      expect(jsonDigest(snapshot)).toBe(row.input_digest);expect(snapshot.readerCapabilities).toBeUndefined();
      // The job may have advanced epochs since this immutable operation was paid.
      const epoch=Array.from({length:Number(row.retry_epoch)+1},(_,index)=>index)
        .find(index=>agentOperationId(row.step_id,"agent_decision",index)===row.logical_operation_id);
      expect(epoch).toBeDefined();
      const logical=agentOperationId(row.step_id,"agent_decision",epoch!);
      expect(logical).toBe(row.logical_operation_id);expect(stableExecutionId(logical,`attempt:${row.attempt}`)).toBe(row.operation_id);
      const binding={jobId:row.job_id,runId:row.run_id,decisionStepId:row.step_id,retryEpoch:epoch!,inputDigest:row.input_digest,schemaDigest:row.schema_digest};
      const tx=client as unknown as DbTransaction;
      const retryPolicy=await readAgentDecisionRetryPolicy(tx,binding),modelRetry=await readAgentDecisionModelRetryPolicy(tx,binding);
      const unknownResponse=new Error("The original request has no saved response; preserve its hold");
      const recover=vi.fn(async(_context:unknown,digest:string)=>{
        expect(digest).toBe(row.request_digest);
        if(row.state==="unknown")throw unknownResponse;
        return{reservation:{id:row.operation_id,budgetId:row.budget_id,requestDigest:row.request_digest,amountMicroUsd:row.reserved_micro_usd,state:row.state},
          receipt:{providerRequestId:row.provider_request_id,responseDigest:row.response_digest,reportedCostUsd:row.reported_cost_usd,usage:row.usage,result:row.result}};
      });
      const network=vi.fn<typeof fetch>(async()=>{throw new Error("No network permitted");});
      const model=new OpenRouterModel({apiKey:()=>undefined,budget:{recover} as unknown as BudgetPort,fetcher:network,
        // Production resolves an existing paid operation from its saved rate card, not today's active policy.
        resolvePolicy:async()=>ModelPolicySchema.parse(row.operation_policy),
        gate:{snapshot:()=>{throw new Error("No capability query permitted");},assertAvailable:async()=>{throw new Error("No paid request permitted");}},
        rateCards:{current:async()=>{throw new Error("No metadata request permitted");}}});
      const request=buildAgentDecisionRequest(snapshot,{logicalOperationId:logical,reservationId:row.operation_id,
        runStepId:row.step_id,attempt:row.attempt,probe:false},Date.now()+60000,epoch,retryPolicy,modelRetry);
      expect(jsonDigest({version:`agent-decision-v${request.schemaVersion}`})).toBe(row.schema_digest);
      const replay=model.generateStructured(request,new AbortController().signal);
      if(row.state==="unknown")await expect(replay).rejects.toBe(unknownResponse);else await replay;
      expect(recover).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled();expect(jsonDigest(row.captured)).toBe(original);
    }
    await client.query("ROLLBACK");
  }finally{await client.end();}
},30000);
