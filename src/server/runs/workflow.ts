import { sleep } from "workflow";
import { advanceExecutionStep, recoveryReceiptStep } from "./workflow-steps";

export async function executeJobWorkflow(jobId:string){
  "use workflow";
  for(;;){const result=await advanceExecutionStep(jobId);if(result.status==="finished")return {jobId,status:"finished"};if(result.status==="busy")await sleep("5s");}
}
export async function executionRecoveryWorkflow(probeId:string){
  "use workflow";
  return recoveryReceiptStep(probeId);
}
