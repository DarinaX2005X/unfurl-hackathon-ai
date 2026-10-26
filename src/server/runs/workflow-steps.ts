import { getStepMetadata,getWorkflowMetadata,RetryableError } from "workflow";

const interruptionCodes:Readonly<Record<string,string>>=Object.freeze({
  "57014":"database_statement_timeout","55P03":"database_lock_timeout","53300":"database_connection_limit",
  "08000":"database_connection","08001":"database_connection","08003":"database_connection","08004":"database_connection","08006":"database_connection","08007":"database_connection","08P01":"database_connection",
  "40001":"database_transaction_conflict","40P01":"database_transaction_conflict",
  "42P01":"database_contract","42703":"database_contract","42883":"database_contract","42601":"database_contract","22P02":"database_contract","23503":"database_contract","23505":"database_contract","23514":"database_contract",
  ECONNRESET:"network_connection",ECONNREFUSED:"network_connection",ETIMEDOUT:"network_timeout",EPIPE:"network_connection",ENOTFOUND:"network_dns",EAI_AGAIN:"network_dns",
  CERT_HAS_EXPIRED:"network_tls",DEPTH_ZERO_SELF_SIGNED_CERT:"network_tls",SELF_SIGNED_CERT_IN_CHAIN:"network_tls",UNABLE_TO_VERIFY_LEAF_SIGNATURE:"network_tls",
});
/** Only fixed categories/codes cross the retry boundary; never preserve raw messages, SQL, URLs or parameters. */
export function safeExecutionInterruption(error:unknown):{category:string;code:string}{
  let value=error,fallback={category:"unknown_infrastructure",code:"unclassified"};const seen=new Set<object>();
  for(let depth=0;depth<4&&value!==null&&typeof value==="object"&&!seen.has(value);depth++){
    seen.add(value);
    const read=(key:string)=>{try{return Reflect.get(value as object,key) as unknown;}catch{return undefined;}};
    const code=read("code"),name=read("name"),message=read("message");
    if(typeof code==="string"&&Object.hasOwn(interruptionCodes,code))return{category:interruptionCodes[code]!,code};
    if(message==="timeout exceeded when trying to connect"||message==="Connection terminated due to connection timeout")fallback={category:"database_pool_timeout",code:"pool_connect_timeout"};
    else if(typeof name==="string"&&["TypeError","ReferenceError","RangeError","SyntaxError","ZodError"].includes(name)&&fallback.code==="unclassified")fallback={category:"runtime_contract",code:name};
    value=read("cause");
  }
  return fallback;
}
export async function advanceExecutionStep(jobId:string){
  "use step";
  const {getRuntime}=await import("./composition");
  try{return await getRuntime().executor.advance(jobId);}catch(error){
    const cause=safeExecutionInterruption(error);
    // RetryableError serialization preserves its message, but does not preserve arbitrary cause fields.
    const retry=new RetryableError(`Execution interruption [${cause.category}:${cause.code}]; preserve lease and recover`,{retryAfter:"300s"});
    retry.cause=cause;throw retry;
  }
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
