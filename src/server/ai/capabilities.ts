import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonObject } from "../../domain/common";
import type { DbTransaction } from "../db";
import { withSystemTransaction } from "../db";
import type { BudgetPort } from "../budget/ports";
import { MODEL_ID, MODEL_POLICY_VERSION, OPENROUTER_BASE_URL, PROVIDER_PRICE_CAP, PROVIDER_TAG, SEARCH_POLICY } from "./constants";
import {modelPolicy,type ModelPolicyId} from "./model-policy";
import { ProviderFailure } from "./failure";
import { canonicalJson, jsonDigest } from "./json";
import type { ModelCapabilities, ProviderCapability, ProviderCapabilityGate } from "./ports";
import { WIRE_SCHEMA_VERSION } from "./wire-schema";
import {portableReceiptBindingSql,ProviderPortabilitySchema,usableProviderPortability} from "./provider-proof-portability";

export type ExecutionCapability = ProviderCapability | "budget_accounting" | "run_recovery" | "dispatcher";
export type RuntimeWorld = "local" | "vercel";
export const CAPABILITY_TEST_VERSION = "runtime-capabilities-v1";
export function runtimeConfigurationDigest(world: RuntimeWorld,policyId?:ModelPolicyId): string {
  if(policyId&&policyId!==MODEL_POLICY_VERSION)return jsonDigest({world,policy:modelPolicy(policyId),search:{...SEARCH_POLICY,maxToolCalls:1},validationPolicy:CAPABILITY_TEST_VERSION,receiptSchema:"provider-receipt-v2"});
  return jsonDigest({ world, model: MODEL_ID, provider: PROVIDER_TAG, modelPolicy: MODEL_POLICY_VERSION,
    priceCaps: { ...PROVIDER_PRICE_CAP }, search: { ...SEARCH_POLICY, maxToolCalls: 1 }, runtime: "fenced-workflow-v1",
    sourceExtractor: "html-text-v1", receiptSchema: "provider-receipt-v2", wireSchema: WIRE_SCHEMA_VERSION, validationPolicy: CAPABILITY_TEST_VERSION });
}
export type CapabilityTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
interface CapabilityRow { id:string; observed_at:Date|string; capability: ExecutionCapability; passed: boolean; fresh: boolean; evidence: JsonObject; invalidated?:boolean;portability_valid?:boolean }
const certificateSchema=z.object({version:z.literal("historical-compatibility-v1"),proofReceiptId:z.uuid(),proofObservedAt:z.iso.datetime(),
  checkedAt:z.iso.datetime(),credentialDigest:z.string().nullable(),endpointName:z.string().nullable(),baseUrl:z.literal(OPENROUTER_BASE_URL)}).strict();
const paidCapability=(value:ExecutionCapability)=>["model_structured","model_text","research_search","rubric"].includes(value);
function credentialDigest(){return process.env.OPENROUTER_API_KEY?jsonDigest({credential:process.env.OPENROUTER_API_KEY}):null;}
export interface CapabilityObservation {
  capability: ExecutionCapability; passed: boolean; testVersion: string; evidence: JsonObject;
  ttlSeconds: number; instanceId: string;
}

export class PersistedCapabilityGate implements ProviderCapabilityGate {
  private available = new Set<ExecutionCapability>();
  private expiresAt = 0;
  readonly configurationDigest: string;
  constructor(readonly world: RuntimeWorld, private readonly budget: BudgetPort,
    private readonly transaction: CapabilityTransaction = (work) => withSystemTransaction("run_execution", work),readonly modelPolicyId?:ModelPolicyId) {
    this.configurationDigest = runtimeConfigurationDigest(world,modelPolicyId);
  }
  snapshot(): ModelCapabilities {
    const has = (capability: ExecutionCapability) => Date.now() < this.expiresAt && this.available.has(capability);
    return { model: modelPolicy(this.modelPolicyId).model, provider: modelPolicy(this.modelPolicyId).provider, structured: has("model_structured"), text: has("model_text"),
      search: has("research_search"), rubric: has("rubric"), limitations: has("budget_accounting") ? [] : ["capability_evidence_unavailable"] };
  }
  async refresh(): Promise<Set<ExecutionCapability>> {
    const rows = await this.latest();
    this.available = new Set(rows.filter((row) => row.passed&&!row.invalidated&&this.usable(row)).map((row) => row.capability));
    // Synchronous snapshots are advisory and short-lived; admission always queries database time.
    this.expiresAt = Date.now() + 1000;
    return new Set(this.available);
  }
  private async latest(){
    return this.transaction(async (tx) => (await tx.query<CapabilityRow>(`SELECT id,observed_at,capability,passed,expires_at>now() AS fresh,evidence,
      CASE WHEN latest.evidence ? 'portability' THEN ${portableReceiptBindingSql("latest")} ELSE false END AS portability_valid,
      EXISTS(SELECT 1 FROM unfurl.ai_provider_operations o JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
        WHERE o.model_id=$3 AND r.received_at>COALESCE((latest.evidence->'portability'->>'sourceObservedAt')::timestamptz,(latest.evidence->'compatibility'->>'proofObservedAt')::timestamptz,latest.observed_at)
        AND (r.result->>'category' IN ('auth','schema','unsupported_parameter','privacy_route')
          OR (r.result ? 'model' AND (r.result->>'model'<>$3 OR r.result->>'provider'<>$4)))) AS invalidated FROM (
      SELECT DISTINCT ON (capability) id,observed_at,capability,passed,expires_at,evidence,world,configuration_digest FROM unfurl.execution_capability_receipts
      WHERE world=$1 AND configuration_digest=$2 ORDER BY capability,observed_at DESC,id DESC
    ) latest`, [this.world, this.configurationDigest,modelPolicy(this.modelPolicyId).model,modelPolicy(this.modelPolicyId).providerName])).rows);
  }
  private usable(row:CapabilityRow){
    if(row.evidence.portability!==undefined)return row.portability_valid===true&&usableProviderPortability(row.evidence,this.world,this.configurationDigest,row.capability);
    if(row.evidence.compatibility===undefined)return row.fresh;
    const parsed=certificateSchema.safeParse(row.evidence.compatibility);
    return row.capability!=="dispatcher"&&parsed.success&&(!paidCapability(row.capability)||
      (parsed.data.credentialDigest!==null&&parsed.data.credentialDigest===credentialDigest()));
  }
  async assertEndpointCompatible(endpointName:unknown){
    const rows=await this.latest();
    if(rows.some(row=>row.passed&&row.evidence.portability!==undefined&&(!this.usable(row)||ProviderPortabilitySchema.parse(row.evidence.portability).endpointName!==endpointName)))throw new ProviderFailure("unavailable");
    if(rows.some(row=>row.passed&&paidCapability(row.capability)&&row.evidence.compatibility!==undefined&&
      (!this.usable(row)||certificateSchema.parse(row.evidence.compatibility).endpointName!==endpointName)))throw new ProviderFailure("unavailable");
  }
  /** Upgrade actual proofs with unpaid revalidation; preserve their original inference/recovery timestamp. */
  async certifyHistoricalProofs(verify:(capability:ExecutionCapability,evidence:JsonObject)=>Promise<{endpointName:string|null}>){
    const rows=await this.latest();
    for(const row of rows){
      if(!row.passed||row.invalidated||row.capability==="dispatcher"||row.evidence.compatibility!==undefined||row.evidence.portability!==undefined)continue;
      const verified=await verify(row.capability,row.evidence);
      const compatibility={version:"historical-compatibility-v1",proofReceiptId:row.id,proofObservedAt:new Date(row.observed_at).toISOString(),
        checkedAt:new Date().toISOString(),credentialDigest:paidCapability(row.capability)?credentialDigest():null,endpointName:verified.endpointName,baseUrl:OPENROUTER_BASE_URL};
      certificateSchema.parse(compatibility);
      await this.observe({capability:row.capability,passed:true,testVersion:CAPABILITY_TEST_VERSION,ttlSeconds:86400,
        instanceId:"unpaid-compatibility-validation",evidence:{...row.evidence,compatibility}});
    }
  }
  async assertAvailable(capability: ProviderCapability, options: { probe: boolean }): Promise<void> {
    const available = await this.refresh();
    if (!available.has("budget_accounting") || (!options.probe && !available.has(capability)) ||
      (!options.probe && capability === "rubric" && !available.has("model_structured"))) throw new ProviderFailure("unavailable");
    await this.budget.assertAvailable(options);
  }
  async assertExecutionAvailable(required: readonly ExecutionCapability[],options:{deferBudget?:boolean}={}): Promise<void> {
    const available = await this.refresh();
    if (!["budget_accounting", "dispatcher", "run_recovery", ...required].every((item) => available.has(item as ExecutionCapability))) throw new ProviderFailure("unavailable");
    if(!options.deferBudget)await this.budget.assertAvailable({ probe: false });
  }
  /** Trusted probe/dispatcher writers only. Successful paid proofs must reference a saved settled operation. */
  async observe(observation: CapabilityObservation): Promise<void> {
    // Cross-world authorization has a separate verifier/writer; generic observations cannot assert it.
    if(observation.evidence.portability!==undefined)throw new ProviderFailure("unavailable");
    if (!Number.isSafeInteger(observation.ttlSeconds) || observation.ttlSeconds < 1 || observation.ttlSeconds > 86400 ||
      (observation.capability === "dispatcher" && observation.ttlSeconds > 120) ||
      !/^[\w:.-]{1,128}$/.test(observation.instanceId) || !observation.testVersion || observation.testVersion.length > 80) throw new ProviderFailure("unavailable");
    canonicalJson(observation.evidence, 64 * 1024);
    await this.transaction(async (tx) => {
      if(observation.evidence.compatibility!==undefined){
        const certificate=certificateSchema.parse(observation.evidence.compatibility);
        // Serialize writers so a concurrent failure cannot be hidden by an old proof's upgrade.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${this.world}:${this.configurationDigest}:${observation.capability}`]);
        const latest=(await tx.query<{id:string}>(`SELECT id FROM unfurl.execution_capability_receipts WHERE world=$1 AND configuration_digest=$2 AND capability=$3
          ORDER BY observed_at DESC,id DESC LIMIT 1`,[this.world,this.configurationDigest,observation.capability])).rows[0];
        if(latest?.id!==certificate.proofReceiptId)return;
      }else await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${this.world}:${this.configurationDigest}:${observation.capability}`]);
      if (observation.passed && ["model_structured", "model_text", "research_search", "rubric"].includes(observation.capability)) {
        const operationId = observation.evidence.operationId;
        if (typeof operationId !== "string") throw new ProviderFailure("unavailable");
        const saved = (await tx.query<{ id: string }>(`SELECT o.id FROM unfurl.ai_provider_operations o
          JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
          WHERE o.id=$1 AND o.state='settled' AND o.purpose='capability_probe' AND r.result IS NOT NULL`, [operationId])).rows[0];
        if (!saved) throw new ProviderFailure("unavailable");
      }
      await tx.query(`INSERT INTO unfurl.execution_capability_receipts
        (id,capability,world,configuration_digest,test_version,passed,evidence_digest,evidence,expires_at,instance_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9),$10)`,
      [randomUUID(), observation.capability, this.world, this.configurationDigest, observation.testVersion, observation.passed,
        jsonDigest(observation.evidence, 64 * 1024), JSON.stringify(observation.evidence), observation.ttlSeconds, observation.instanceId]);
    });
    this.expiresAt = 0;
  }
}
