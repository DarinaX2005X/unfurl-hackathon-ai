import "server-only";
import type {DbTransaction} from "../db";
import {withSystemTransaction} from "../db";
import {CANDIDATE_MODEL_POLICY,modelPolicy,type ModelPolicyId} from "./model-policy";
import {MODEL_POLICY_VERSION} from "./constants";
import {runtimeConfigurationDigest} from "./capabilities";
import {jsonDigest} from "./json";
import {ProviderFailure} from "./failure";

interface SelectedProof {id:string;configuration_digest:string;credential_digest:string|null;rejected:boolean}

/** A settled successful proof durably selects the route for this campaign/world.
 * Expiry and compatibility affect availability, never the selected model identity. */
async function selectedProof(tx:DbTransaction):Promise<SelectedProof|undefined>{
  return (await tx.query<SelectedProof>(`SELECT proof.id,proof.configuration_digest,
      proof.evidence->>'credentialDigest' AS credential_digest,
      EXISTS(SELECT 1 FROM unfurl.ai_provider_operations newer JOIN unfurl.ai_provider_responses failed ON failed.operation_id=newer.id
        WHERE newer.budget_id=o.budget_id AND newer.model_id=o.model_id AND failed.received_at>proof.observed_at
          AND failed.result->>'category' IN ('auth','schema','unsupported_parameter','privacy_route')) AS rejected
    FROM unfurl.execution_capability_receipts proof
    JOIN unfurl.ai_provider_operations o ON o.id=(proof.evidence->>'operationId')::uuid
    JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
    WHERE proof.capability='model_structured' AND proof.passed AND proof.world=$1
      AND proof.evidence->>'modelPolicy'=$2 AND proof.evidence->>'test'='saved-decision-native-schema-v2'
      AND o.budget_id=$3 AND o.purpose='capability_probe' AND o.state='settled'
      AND o.model_id='google/gemini-3.8-flash' AND o.provider_tag='google-ai-studio'
      AND r.result->>'model'=o.model_id AND r.result->>'provider'='Google AI Studio'
      AND r.result->>'finishReason'='stop' AND r.result->'failure'='null'::jsonb
    ORDER BY proof.observed_at DESC LIMIT 1`,[process.env.VERCEL?"vercel":"local",CANDIDATE_MODEL_POLICY,
    process.env.AI_BUDGET_ID??null])).rows[0];
}

/** Before any candidate was selected, historical operations retain the bootstrap policy. */
export async function readActiveModelPolicy(tx:DbTransaction):Promise<ModelPolicyId>{
  return await selectedProof(tx)?CANDIDATE_MODEL_POLICY:MODEL_POLICY_VERSION;
}
export async function assertModelPolicyAvailable(policy:ModelPolicyId,probe:boolean){
  if(policy===MODEL_POLICY_VERSION||probe)return;
  const proof=await withSystemTransaction("run_execution",selectedProof);
  if(policy!==CANDIDATE_MODEL_POLICY||!proof||proof.rejected||
    proof.configuration_digest!==runtimeConfigurationDigest(process.env.VERCEL?"vercel":"local",policy)||
    proof.credential_digest!==jsonDigest({credential:process.env.OPENROUTER_API_KEY??""}))throw new ProviderFailure("unavailable");
  // The adapter still checks current endpoint/rates and durable budget admission per new call.
}
export async function activeModelIdentity(tx:DbTransaction){const id=await readActiveModelPolicy(tx);return modelPolicy(id);}
