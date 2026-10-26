import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getRun,start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";
import { withSystemTransaction } from "../db";
import { CAPABILITY_TEST_VERSION } from "../ai/capabilities";
import { OpenRouterAccounting } from "../ai/accounting";
import { configuredFundingIds } from "../budget/funding";
import { getRuntime } from "./composition";
import { executeJobWorkflow,executionRecoveryWorkflow } from "./workflow";

interface OutboxRow{id:string;job_id:string;operation:"start"|"resume"|"cancel";fencing_token:string;workflow_run_id:string|null;status:string}
type DispatchScope={ownerId?:string;runId?:string;maintenance?:boolean};
// Every request-triggered delivery is restricted to already accepted jobs owned by that actor.
const ownedJob=`($1::uuid IS NULL OR EXISTS(SELECT 1 FROM unfurl.agent_turn_runs a WHERE a.id=j.agent_turn_run_id AND a.owner_id=$1)
  OR EXISTS(SELECT 1 FROM unfurl.generation_runs g WHERE g.id=j.generation_run_id AND g.owner_id=$1)
  OR EXISTS(SELECT 1 FROM unfurl.evaluations e JOIN unfurl.attempts a ON a.id=e.attempt_id WHERE e.id=j.evaluation_id AND a.learner_id=$1)
  OR EXISTS(SELECT 1 FROM unfurl.activity_actions a JOIN unfurl.activity_sessions s ON s.id=a.activity_session_id
    JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE a.id=j.activity_action_id AND e.learner_id=$1))
  AND ($2::uuid IS NULL OR j.agent_turn_run_id=$2 OR j.generation_run_id=$2)`;
export async function dispatchOwnedExecution(actor:{id:string},runId?:string){
  // The acceptance transaction has committed. A launch failure must not turn its saved receipt into an error.
  try{return await dispatchExecutionOutbox({ownerId:actor.id,...(runId?{runId}:{}),maintenance:false});}catch{return null;}
}
export async function ensureDispatchReady(){
  await (await import("./compatibility")).certifyRuntimeCompatibility(getRuntime());
  const capabilities=await getRuntime().gate.refresh();
  if(!capabilities.has("dispatcher"))await dispatchExecutionOutbox({maintenance:false});
}
export async function cancelWorkflowDelivery(workflowId:string){
  try{const run=getRun(workflowId);const state=await run.status;
    if(!["completed","failed","cancelled"].includes(state))await run.cancel();
  }catch(error){if(!WorkflowRunNotFoundError.is(error))throw error;}
}
export async function dispatchExecutionOutbox(scope:DispatchScope={}){
  const runtime=getRuntime();const lease=randomUUID();
  const parameters=[scope.ownerId??null,scope.runId??null];
  // A failed SDK workflow is safe to redeliver: durable job/step fences and receipts arbitrate effects.
  const stale=await withSystemTransaction("run_execution",async tx=>(await tx.query<{id:string;workflow_run_id:string|null}>(`SELECT j.id,j.workflow_run_id FROM unfurl.execution_jobs j
    WHERE j.status IN ('queued','running') AND j.updated_at<now()-interval '130 seconds' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=now())
    AND (j.workflow_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM unfurl.outbox accepted WHERE accepted.job_id=j.id AND accepted.operation IN ('start','resume')))
    AND ${ownedJob} ORDER BY j.updated_at LIMIT 12`,parameters)).rows);
  let recovered=0;
  for(const job of stale){
    try{let state:string|null=null;
      try{state=job.workflow_run_id?await getRun(job.workflow_run_id).status:null;}catch(error){if(!WorkflowRunNotFoundError.is(error))throw error;}
      if(state&&!['failed','cancelled','completed'].includes(state))continue;
      await withSystemTransaction("run_execution",async tx=>{const current=(await tx.query<{id:string}>(`SELECT id FROM unfurl.execution_jobs WHERE id=$1 AND status IN ('queued','running')
        AND (lease_expires_at IS NULL OR lease_expires_at<=now()) FOR UPDATE`,[job.id])).rows[0];if(!current)return;
        await tx.query(`INSERT INTO unfurl.outbox(id,job_id,operation) VALUES($1,$2,'resume') ON CONFLICT(job_id,operation) DO UPDATE SET dispatched_at=NULL,
          available_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=outbox.fencing_token+1,updated_at=now()`,[randomUUID(),job.id]);});recovered++;
    }catch{/* Next authenticated dispatch can inspect the saved workflow again. */}
  }
  const rows=await withSystemTransaction("run_execution",async tx=>{
    const selected=(await tx.query<OutboxRow>(`SELECT o.id,o.job_id,o.operation,o.fencing_token::text,j.workflow_run_id,j.status FROM unfurl.outbox o
      JOIN unfurl.execution_jobs j ON j.id=o.job_id WHERE o.dispatched_at IS NULL AND o.available_at<=now()
      AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=now()) AND ${ownedJob} ORDER BY o.available_at,o.id LIMIT 12 FOR UPDATE OF o SKIP LOCKED`,parameters)).rows;
    for(const row of selected){const claimed=(await tx.query<{fencing_token:string}>(`UPDATE unfurl.outbox SET lease_owner=$2,lease_expires_at=now()+interval '60 seconds',
      attempt_count=attempt_count+1,fencing_token=fencing_token+1,updated_at=now() WHERE id=$1 RETURNING fencing_token::text`,[row.id,lease])).rows[0]!;row.fencing_token=claimed.fencing_token;}
    return selected;
  });
  let dispatched=0;let failed=0;
  for(const row of rows){
    try{
      let workflowId=row.workflow_run_id;
      if(row.operation==="cancel"){if(workflowId)await cancelWorkflowDelivery(workflowId);}
      else if(["queued","running"].includes(row.status)){const run=await start(executeJobWorkflow,[row.job_id]);workflowId=run.runId;}
      await withSystemTransaction("run_execution",async tx=>{
        const acknowledged=await tx.query(`UPDATE unfurl.outbox SET dispatched_at=now(),lease_owner=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 RETURNING id`,[row.id,lease,row.fencing_token]);
        if(acknowledged.rowCount===1&&workflowId&&row.operation!=="cancel")await tx.query("UPDATE unfurl.execution_jobs SET workflow_run_id=$2,updated_at=now() WHERE id=$1",[row.job_id,workflowId]);
      });dispatched++;
    }catch{
      failed++;await withSystemTransaction("run_execution",tx=>tx.query(`UPDATE unfurl.outbox SET lease_owner=NULL,lease_expires_at=NULL,available_at=now()+interval '30 seconds',
        safe_error='{"code":"dispatch_unavailable"}'::jsonb,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3`,[row.id,lease,row.fencing_token]));
    }
  }
  const unknown=scope.maintenance===false?[]:await withSystemTransaction("run_execution",async tx=>(await tx.query<{id:string;budget_id:string}>(`SELECT o.id,o.budget_id FROM unfurl.ai_provider_operations o WHERE o.budget_id=ANY($1::uuid[])
    AND o.state='unknown' AND o.provider_request_id IS NOT NULL ORDER BY o.updated_at LIMIT 2`,[await configuredFundingIds(tx)])).rows);
  let reconciled=0;for(const row of unknown){try{const accounting=new OpenRouterAccounting(runtime.budgetForId(row.budget_id),()=>process.env.OPENROUTER_API_KEY);if((await accounting.reconcile(row.id,AbortSignal.timeout(10000))).settled)reconciled++;}catch{/* Unknown cost keeps its hold. */}}
  await runtime.gate.observe({capability:"dispatcher",passed:failed===0,testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:90,instanceId:"authenticated-dispatch",
    evidence:{scanned:rows.length,dispatched,failed,recovered,reconciled,local:runtime.gate.world==="local"}});
  return {scanned:rows.length,dispatched,failed,recovered,reconciled};
}
export async function startRecoveryProof(){const probeId=randomUUID();const run=await start(executionRecoveryWorkflow,[probeId]);return {probeId,workflowRunId:run.runId};}
export async function inspectRecoveryProof(workflowRunId:string){
  const run=getRun(workflowRunId);const status=await run.status;if(status!=="completed")return {status};
  const result=z.object({probeId:z.uuid(),workflowRunId:z.string(),stepId:z.string(),firstAttempt:z.number().int().nonnegative(),attempt:z.number().int().positive(),replayed:z.literal(true)}).parse(await run.returnValue);
  if(result.workflowRunId!==workflowRunId||result.attempt<=result.firstAttempt)throw new Error("Unproven workflow recovery");
  const runtime=getRuntime();
  // Provider wire policy changes do not invalidate the actual SDK commit/replay proof.
  const marker=await withSystemTransaction("run_execution",async tx=>(await tx.query<{id:string;configuration_digest:string}>(`SELECT id,configuration_digest FROM unfurl.execution_capability_receipts WHERE id=$1 AND capability='run_recovery'
    AND passed=false AND world=$2 AND test_version=$3 AND evidence->>'workflowRunId'=$4 AND evidence->>'stepId'=$5
    AND evidence->>'marker'='committed-before-sdk-retry' AND (evidence->>'attempt')::integer=$6`,[result.probeId,runtime.gate.world,CAPABILITY_TEST_VERSION,workflowRunId,result.stepId,result.firstAttempt])).rows[0]);
  if(!marker)throw new Error("Missing recovery receipt");
  await runtime.gate.observe({capability:"run_recovery",passed:true,testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:86400,instanceId:"workflow-recovery-probe",evidence:{...result,proofConfigurationDigest:marker.configuration_digest,runner:"fenced-workflow-v1"}});
  return {status:"completed",proof:result};
}
