import "server-only";
import {modelPolicy,type ModelPolicyId} from "./model-policy";
import type {ModelPort,ModelRequestBase} from "./ports";

/** A new generation capture selects one policy. The transport still resolves
 * already allocated operations first; rubric behavior keeps its own proof.
 */
export function withCapturedModelPolicy(model:ModelPort,policy:ModelPolicyId|undefined):ModelPort{
  if(policy===undefined)return model;
  const bind=<T extends ModelRequestBase>(request:T):T=>request.purpose==="rubric_grading"||request.modelPolicy?request:
    {...request,modelPolicy:policy,model:modelPolicy(policy).model};
  return {capabilities:()=>model.capabilities(),
    generateStructured:(request,signal)=>model.generateStructured(bind(request),signal),
    streamText:(request,signal)=>model.streamText(bind(request),signal)};
}
