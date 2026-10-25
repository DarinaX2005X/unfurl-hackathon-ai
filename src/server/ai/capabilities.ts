import "server-only";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../domain/common";
import type { DbTransaction } from "../db";
import { withSystemTransaction } from "../db";
import type { BudgetPort } from "../budget/ports";
import { MODEL_ID, MODEL_POLICY_VERSION, PROVIDER_PRICE_CAP, PROVIDER_TAG, SEARCH_POLICY } from "./constants";
import { ProviderFailure } from "./failure";
import { canonicalJson, jsonDigest } from "./json";
import type { ModelCapabilities, ProviderCapability, ProviderCapabilityGate } from "./ports";

export type ExecutionCapability = ProviderCapability | "budget_accounting" | "run_recovery" | "dispatcher";
export type RuntimeWorld = "local" | "vercel";
export const CAPABILITY_TEST_VERSION = "runtime-capabilities-v1";
export function runtimeConfigurationDigest(world: RuntimeWorld): string {
  return jsonDigest({ world, model: MODEL_ID, provider: PROVIDER_TAG, modelPolicy: MODEL_POLICY_VERSION,
    priceCaps: { ...PROVIDER_PRICE_CAP }, search: { ...SEARCH_POLICY, maxToolCalls: 1 }, runtime: "fenced-workflow-v1",
    sourceExtractor: "html-text-v1", receiptSchema: "provider-receipt-v1", validationPolicy: CAPABILITY_TEST_VERSION });
}
export type CapabilityTransaction = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
interface CapabilityRow { capability: ExecutionCapability; passed: boolean; fresh: boolean; evidence: JsonObject }
export interface CapabilityObservation {
  capability: ExecutionCapability; passed: boolean; testVersion: string; evidence: JsonObject;
  ttlSeconds: number; instanceId: string;
}

export class PersistedCapabilityGate implements ProviderCapabilityGate {
  private available = new Set<ExecutionCapability>();
  private expiresAt = 0;
  readonly configurationDigest: string;
  constructor(readonly world: RuntimeWorld, private readonly budget: BudgetPort,
    private readonly transaction: CapabilityTransaction = (work) => withSystemTransaction("run_execution", work)) {
    this.configurationDigest = runtimeConfigurationDigest(world);
  }
  snapshot(): ModelCapabilities {
    const has = (capability: ExecutionCapability) => Date.now() < this.expiresAt && this.available.has(capability);
    return { model: MODEL_ID, provider: PROVIDER_TAG, structured: has("model_structured"), text: has("model_text"),
      search: has("research_search"), rubric: has("rubric"), limitations: has("budget_accounting") ? [] : ["capability_evidence_unavailable"] };
  }
  async refresh(): Promise<Set<ExecutionCapability>> {
    const rows = await this.transaction(async (tx) => (await tx.query<CapabilityRow>(`SELECT capability,passed,expires_at>now() AS fresh,evidence FROM (
      SELECT DISTINCT ON (capability) capability,passed,expires_at,evidence FROM unfurl.execution_capability_receipts
      WHERE world=$1 AND configuration_digest=$2 ORDER BY capability,observed_at DESC,id DESC
    ) latest`, [this.world, this.configurationDigest])).rows);
    this.available = new Set(rows.filter((row) => row.passed && row.fresh).map((row) => row.capability));
    // Synchronous snapshots are advisory and short-lived; admission always queries database time.
    this.expiresAt = Date.now() + 1000;
    return new Set(this.available);
  }
  async assertAvailable(capability: ProviderCapability, options: { probe: boolean }): Promise<void> {
    const available = await this.refresh();
    if (!available.has("budget_accounting") || (!options.probe && !available.has(capability)) ||
      (!options.probe && capability === "rubric" && !available.has("model_structured"))) throw new ProviderFailure("unavailable");
    await this.budget.assertAvailable(options);
  }
  async assertExecutionAvailable(required: readonly ExecutionCapability[]): Promise<void> {
    const available = await this.refresh();
    if (!["budget_accounting", "dispatcher", "run_recovery", ...required].every((item) => available.has(item as ExecutionCapability))) throw new ProviderFailure("unavailable");
    await this.budget.assertAvailable({ probe: false });
  }
  /** Trusted probe/dispatcher writers only. Successful paid proofs must reference a saved settled operation. */
  async observe(observation: CapabilityObservation): Promise<void> {
    if (!Number.isSafeInteger(observation.ttlSeconds) || observation.ttlSeconds < 1 || observation.ttlSeconds > 86400 ||
      (observation.capability === "dispatcher" && observation.ttlSeconds > 120) ||
      !/^[\w:.-]{1,128}$/.test(observation.instanceId) || !observation.testVersion || observation.testVersion.length > 80) throw new ProviderFailure("unavailable");
    canonicalJson(observation.evidence, 64 * 1024);
    await this.transaction(async (tx) => {
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
