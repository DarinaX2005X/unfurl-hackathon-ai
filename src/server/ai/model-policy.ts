import "server-only";
import {z} from "zod";
import {MODEL_ID,MODEL_POLICY_VERSION,PROVIDER_TAG,PROVIDER_PRICE_CAP} from "./constants";

export const ModelPolicySchema=z.enum(["kimi-digitalocean-v1","gemini-flash-google-v1","gemini-flash-google-schema-v2","gemini-flash-google-schema-v3","gemini-flash-google-schema-v4"]);
export type ModelPolicyId=z.infer<typeof ModelPolicySchema>;
export const SEARCH_HEADROOM_POLICY="bounded-search-headroom-v2" as const;
export const SearchPolicySchema=z.literal(SEARCH_HEADROOM_POLICY);
export type SearchPolicyId=z.infer<typeof SearchPolicySchema>;
export const GEMINI_SCHEMA_V2_POLICY="gemini-flash-google-schema-v2" as const;
export const CANDIDATE_MODEL_POLICY="gemini-flash-google-schema-v3" as const;
export const legacyCandidatePolicy=Object.freeze({id:"gemini-flash-google-v1",model:"google/gemini-3.8-flash",provider:"google-ai-studio",
  providerName:"Google AI Studio",priceCaps:{prompt:"0.00000075",completion:"0.00000375"},transport:"sse-v1",wireSchema:"native-json-schema-v1"} as const);
export const schemaV2Policy=Object.freeze({...legacyCandidatePolicy,id:GEMINI_SCHEMA_V2_POLICY,wireSchema:"gemini-native-shape-v2"} as const);
export const candidatePolicy=Object.freeze({...legacyCandidatePolicy,id:CANDIDATE_MODEL_POLICY,wireSchema:"gemini-native-shape-v3"} as const);
export const GEMINI_SCHEMA_V3_PROOF="saved-coverage-native-schema-v3" as const;
export const GEMINI_SCHEMA_V4_POLICY="gemini-flash-google-schema-v4" as const;
export const GEMINI_SCHEMA_V4_PROOF="saved-coverage-json-mode-v4" as const;
export const schemaV4Policy=Object.freeze({...legacyCandidatePolicy,id:GEMINI_SCHEMA_V4_POLICY,wireSchema:"gemini-recursive-json-mode-v4"} as const);
export function structuredPolicyProof(id:ModelPolicyId):string|null{
  return id===GEMINI_SCHEMA_V4_POLICY?GEMINI_SCHEMA_V4_PROOF:id===CANDIDATE_MODEL_POLICY?GEMINI_SCHEMA_V3_PROOF:id===GEMINI_SCHEMA_V2_POLICY?"saved-decision-native-schema-v2":null;
}
export function modelPolicy(id:ModelPolicyId=MODEL_POLICY_VERSION){
  if(id===GEMINI_SCHEMA_V4_POLICY)return schemaV4Policy;
  if(id===CANDIDATE_MODEL_POLICY)return candidatePolicy;
  if(id===GEMINI_SCHEMA_V2_POLICY)return schemaV2Policy;
  if(id===legacyCandidatePolicy.id)return legacyCandidatePolicy;
  if(id!==MODEL_POLICY_VERSION)throw new Error("Unknown model policy");
  return {id:MODEL_POLICY_VERSION,model:MODEL_ID,provider:PROVIDER_TAG,providerName:"DigitalOcean",priceCaps:PROVIDER_PRICE_CAP,transport:"buffered-v1",wireSchema:"prompt-schema-v1"} as const;
}
export function executionTiming(){return process.env.VERCEL?
  {providerMs:260000,stepMs:270000,stepLeaseSeconds:285,jobLeaseSeconds:295}:
  {providerMs:1800000,stepMs:1810000,stepLeaseSeconds:1825,jobLeaseSeconds:1835};}
