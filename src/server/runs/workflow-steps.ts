import { getStepMetadata,getWorkflowMetadata,RetryableError } from "workflow";

export async function advanceExecutionStep(jobId:string){
  "use step";
  const {getRuntime}=await import("./composition");
  try{return await getRuntime().executor.advance(jobId);}catch{throw new RetryableError("Execution storage interruption; preserve lease and recover",{retryAfter:"300s"});}
}
export async function recoveryReceiptStep(probeId:string){
  "use step";
  const {z}=await import("zod");const {withSystemTransaction}=await import("../db");
  const {runtimeConfigurationDigest,CAPABILITY_TEST_VERSION}=await import("../ai/capabilities");
  const {jsonDigest}=await import("../ai/json");
  z.uuid().parse(probeId);const step=getStepMetadata();const workflow=getWorkflowMetadata();
  const world=process.env.VERCEL?"vercel":"local";const configuration=runtimeConfigurationDigest(world);
  const result=await withSystemTransaction("run_execution",async tx=>{
    const existing=(await tx.query<{evidence:{workflowRunId:string;stepId:string;attempt:number};configuration_digest:string}>("SELECT evidence,configuration_digest FROM unfurl.execution_capability_receipts WHERE id=$1",[probeId])).rows[0];
    if(existing){if(existing.configuration_digest!==configuration||existing.evidence.workflowRunId!==workflow.workflowRunId||existing.evidence.stepId!==step.stepId||step.attempt<=existing.evidence.attempt)throw new Error("Recovery proof identity mismatch");
      return {probeId,workflowRunId:workflow.workflowRunId,stepId:step.stepId,firstAttempt:existing.evidence.attempt,attempt:step.attempt,replayed:true};}
    const evidence={workflowRunId:workflow.workflowRunId,stepId:step.stepId,attempt:step.attempt,marker:"committed-before-sdk-retry"};
    await tx.query(`INSERT INTO unfurl.execution_capability_receipts(id,capability,world,configuration_digest,test_version,passed,evidence_digest,evidence,expires_at,instance_id)
      VALUES($1,'run_recovery',$2,$3,$4,false,$5,$6,now()+interval '10 minutes','workflow-recovery-probe')`,[probeId,world,configuration,CAPABILITY_TEST_VERSION,jsonDigest(evidence),JSON.stringify(evidence)]);
    return null;
  });
  if(result===null)throw new RetryableError("Intentional recovery proof interruption after committed receipt",{retryAfter:"1s"});
  return result;
}
