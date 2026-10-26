import "server-only";
import type {DbTransaction} from "../db";
import {withSystemTransaction} from "../db";
import {CANDIDATE_MODEL_POLICY,modelPolicy,type ModelPolicyId} from "./model-policy";
import {MODEL_POLICY_VERSION} from "./constants";
import {runtimeConfigurationDigest} from "./capabilities";
import {jsonDigest} from "./json";
import {ProviderFailure} from "./failure";

/** A configuration string cannot activate a paid route: only the saved successful real-schema proof can. */
export async function readActiveModelPolicy(tx:DbTransaction):Promise<ModelPolicyId>{
  const row=(await tx.query<{id:string}>(`SELECT proof.id FROM unfurl.execution_capability_receipts proof
    JOIN unfurl.ai_provider_operations o ON o.id=(proof.evidence->>'operationId')::uuid
    JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
    WHERE proof.capability='model_structured' AND proof.passed AND proof.world=$1
      AND proof.evidence->>'modelPolicy'=$2 AND proof.evidence->>'credentialDigest'=$3
      AND proof.configuration_digest=$5 AND proof.evidence->>'test'='saved-decision-native-schema-v2' AND proof.expires_at>now()
      AND o.budget_id=$4 AND o.purpose='capability_probe' AND o.state='settled'
      AND o.model_id='google/gemini-3.8-flash' AND o.provider_tag='google-ai-studio'
      AND r.result->>'model'=o.model_id AND r.result->>'provider'='Google AI Studio'
      AND r.result->>'finishReason'='stop' AND r.result->'failure'='null'::jsonb
      AND NOT EXISTS(SELECT 1 FROM unfurl.ai_provider_operations newer JOIN unfurl.ai_provider_responses failed ON failed.operation_id=newer.id
        WHERE newer.budget_id=o.budget_id AND newer.model_id=o.model_id AND failed.received_at>proof.observed_at
          AND failed.result->>'category' IN ('auth','schema','unsupported_parameter','privacy_route'))
    ORDER BY proof.observed_at DESC LIMIT 1`,[process.env.VERCEL?"vercel":"local",CANDIDATE_MODEL_POLICY,
    jsonDigest({credential:process.env.OPENROUTER_API_KEY??""}),process.env.AI_BUDGET_ID??null,runtimeConfigurationDigest(process.env.VERCEL?"vercel":"local",CANDIDATE_MODEL_POLICY)])).rows[0];
  return row?CANDIDATE_MODEL_POLICY:MODEL_POLICY_VERSION;
}
export async function assertModelPolicyAvailable(policy:ModelPolicyId,probe:boolean){
  if(policy===MODEL_POLICY_VERSION||probe)return;
  if(await withSystemTransaction("run_execution",readActiveModelPolicy)!==policy)throw new ProviderFailure("unavailable");
}
export async function activeModelIdentity(tx:DbTransaction){const id=await readActiveModelPolicy(tx);return modelPolicy(id);}
