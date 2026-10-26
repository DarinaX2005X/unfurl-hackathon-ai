import "server-only";
import type {DbTransaction} from "../db";
import {withSystemTransaction} from "../db";
import {CANDIDATE_MODEL_POLICY,GEMINI_SCHEMA_V2_POLICY,GEMINI_SCHEMA_V4_POLICY,modelPolicy,structuredPolicyProof,type ModelPolicyId} from "./model-policy";
import {MODEL_POLICY_VERSION} from "./constants";
import {runtimeConfigurationDigest} from "./capabilities";
import {jsonDigest} from "./json";
import {ProviderFailure} from "./failure";
import type {JsonObject} from "../../domain/common";
import {portableReceiptBindingSql,usableProviderPortability} from "./provider-proof-portability";

interface SelectedProof {id:string;configuration_digest:string;credential_digest:string|null;rejected:boolean;evidence?:JsonObject;portability_valid?:boolean}

/** A settled successful original proof durably selects the route for this campaign.
 * Expiry and compatibility affect availability, never the selected model identity. */
async function selectedProof(tx:DbTransaction,availability=false,policy:ModelPolicyId=CANDIDATE_MODEL_POLICY):Promise<SelectedProof|undefined>{
  return (await tx.query<SelectedProof>(`SELECT proof.id,proof.configuration_digest,
      proof.evidence,COALESCE(proof.evidence->'portability'->>'credentialDigest',proof.evidence->>'credentialDigest') AS credential_digest,
      CASE WHEN proof.evidence ? 'portability' THEN ${portableReceiptBindingSql("proof")} ELSE false END AS portability_valid,
      EXISTS(SELECT 1 FROM unfurl.ai_provider_operations newer JOIN unfurl.ai_provider_responses failed ON failed.operation_id=newer.id
        WHERE newer.model_id=o.model_id
          AND failed.received_at>COALESCE((proof.evidence->'portability'->>'sourceObservedAt')::timestamptz,proof.observed_at)
          AND (failed.result->>'category' IN ('auth','schema','unsupported_parameter','privacy_route')
            OR (failed.result ? 'model' AND (failed.result->>'model'<>o.model_id OR failed.result->>'provider'<>'Google AI Studio'))))
        OR EXISTS(SELECT 1 FROM unfurl.execution_capability_receipts failed WHERE failed.capability=proof.capability
          AND failed.world=proof.world AND failed.configuration_digest=proof.configuration_digest AND NOT failed.passed
          AND failed.observed_at>COALESCE((proof.evidence->'portability'->>'sourceObservedAt')::timestamptz,proof.observed_at)) AS rejected
    FROM unfurl.execution_capability_receipts proof
    JOIN unfurl.ai_provider_operations o ON o.id=(proof.evidence->>'operationId')::uuid
    JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
    WHERE proof.capability='model_structured' AND proof.passed
      AND (CASE WHEN $4::boolean THEN proof.world=$1 ELSE NOT(proof.evidence ? 'portability') END)
      AND proof.evidence->>'modelPolicy'=$2 AND proof.evidence->>'test'=$5
      AND proof.evidence->>'requestDigest'=o.request_digest AND o.rate_card->>'policyVersion'=$2
      AND ($2 NOT IN ('gemini-flash-google-schema-v3','gemini-flash-google-schema-v4') OR (proof.evidence->>'evidenceValidated'='true'
        AND proof.evidence ? 'sourceBinding' AND proof.evidence ? 'canonicalSchemaDigest'))
      AND ($2<>'gemini-flash-google-schema-v4' OR (proof.evidence->>'responseFormat'='json_object'
        AND proof.evidence->>'wireSchema'='gemini-recursive-json-mode-v4'
        AND proof.evidence->>'settled'='true' AND proof.evidence->>'responseDigest'=r.response_digest))
      AND o.budget_id=$3 AND o.purpose='capability_probe' AND o.state='settled'
      AND o.model_id='google/gemini-3.8-flash' AND o.provider_tag='google-ai-studio'
      AND r.result->>'model'=o.model_id AND r.result->>'provider'='Google AI Studio'
      AND r.result->>'finishReason'='stop' AND r.result->'failure'='null'::jsonb
    ORDER BY proof.observed_at DESC LIMIT 1`,[process.env.VERCEL?"vercel":"local",policy,
    process.env.AI_BUDGET_ID??null,availability,structuredPolicyProof(policy)])).rows[0];
}

/** Before any candidate was selected, historical operations retain the bootstrap policy. */
export async function readActiveModelPolicy(tx:DbTransaction,options:{allowSchemaV3?:boolean}={}):Promise<ModelPolicyId>{
  // Historical uncaptured calls already pass false; keep all newly captured
  // policies out of that path, including v4.
  if(options.allowSchemaV3!==false&&await selectedProof(tx,false,GEMINI_SCHEMA_V4_POLICY))return GEMINI_SCHEMA_V4_POLICY;
  if(options.allowSchemaV3!==false&&await selectedProof(tx))return CANDIDATE_MODEL_POLICY;
  return await selectedProof(tx,false,GEMINI_SCHEMA_V2_POLICY)?GEMINI_SCHEMA_V2_POLICY:MODEL_POLICY_VERSION;
}
export async function assertModelPolicyAvailable(policy:ModelPolicyId,probe:boolean){
  if(policy===MODEL_POLICY_VERSION||probe)return;
  const proof=await withSystemTransaction("run_execution",tx=>selectedProof(tx,true,policy));
  if(!structuredPolicyProof(policy)||!proof||proof.rejected||
    proof.configuration_digest!==runtimeConfigurationDigest(process.env.VERCEL?"vercel":"local",policy)||
    proof.credential_digest!==jsonDigest({credential:process.env.OPENROUTER_API_KEY??""})||
    proof.evidence?.portability!==undefined&&(!proof.portability_valid||!usableProviderPortability(proof.evidence,process.env.VERCEL?"vercel":"local",proof.configuration_digest,"model_structured")))throw new ProviderFailure("unavailable");
  // The adapter still checks current endpoint/rates and durable budget admission per new call.
}
export async function activeModelIdentity(tx:DbTransaction){const id=await readActiveModelPolicy(tx);return modelPolicy(id);}
