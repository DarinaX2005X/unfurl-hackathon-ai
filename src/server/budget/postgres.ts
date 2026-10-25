import "server-only";
import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../db";
import { withSystemTransaction } from "../db";
import { MODEL_ID, PROVIDER_TAG } from "../ai/constants";
import { canonicalJson, jsonDigest } from "../ai/json";
import { ProviderFailure, type ProviderFailureCode } from "../ai/failure";
import { canReserve, type BudgetState } from "./calculations";
import {NATIVE_USAGE_VERSION,normalizeNativeUsage} from "../ai/native-usage";
import type {JsonObject} from "../../domain/common";
import { readMicroUsd } from "./money";
import type { BudgetOperationContext, BudgetPort, BudgetReservation, DispatchDecision, ProviderResponseReceipt, ReserveRequest } from "./ports";

export type BudgetTransactionRunner = <T>(work: (tx: DbTransaction) => Promise<T>) => Promise<T>;
interface CampaignRow { id: string; settled_micro_usd: string; reserved_micro_usd: string; halted: boolean }
interface OperationRow {
  id: string; budget_id: string; logical_operation_id: string; attempt: number; run_step_id: string | null;
  request_digest: string; purpose: string; state: BudgetReservation["state"]; reserved_micro_usd: string;
  actual_micro_usd: string | null; rate_card_digest: string; rate_card: unknown;
}
interface ReceiptRow { provider_request_id: string | null; response_digest: string; reported_cost_usd: string | null; usage: ProviderResponseReceipt["usage"]; result: ProviderResponseReceipt["result"] }
const unavailable = () => new ProviderFailure("unavailable");
function reservation(row: OperationRow): BudgetReservation {
  return { id: row.id, budgetId: row.budget_id, requestDigest: row.request_digest, amountMicroUsd: row.reserved_micro_usd, state: row.state };
}
function receipt(row: ReceiptRow): ProviderResponseReceipt {
  return { providerRequestId: row.provider_request_id, responseDigest: row.response_digest,
    reportedCostUsd: row.reported_cost_usd, usage: row.usage, result: row.result };
}

/** All state changes serialize on the fixed campaign first. No expiry refunds and no network I/O. */
export class PostgresBudget implements BudgetPort {
  constructor(readonly budgetId: string, private readonly transaction: BudgetTransactionRunner =
    (work) => withSystemTransaction("run_execution", work)) {}

  private async lock(tx: DbTransaction): Promise<CampaignRow> {
    const row = (await tx.query<CampaignRow>(`SELECT id, settled_micro_usd::text, reserved_micro_usd::text, halted
      FROM unfurl.ai_budgets WHERE id=$1 FOR UPDATE`, [this.budgetId])).rows[0];
    if (!row) throw unavailable();
    return row;
  }
  private async state(tx: DbTransaction, row: CampaignRow): Promise<BudgetState> {
    const sums = (await tx.query<{ outstanding: string; probe_settled: string; probe_reserved: string }>(`SELECT
      count(*) FILTER (WHERE state IN ('reserved','dispatched','unknown') AND NOT EXISTS
        (SELECT 1 FROM unfurl.ai_provider_terminal_http_400_receipts terminal WHERE terminal.operation_id=ai_provider_operations.id))::text AS outstanding,
      coalesce(sum(actual_micro_usd) FILTER (WHERE purpose='capability_probe' AND state='settled'),0)::text AS probe_settled,
      coalesce(sum(reserved_micro_usd) FILTER (WHERE purpose='capability_probe' AND state IN ('reserved','dispatched','unknown')),0)::text AS probe_reserved
      FROM unfurl.ai_provider_operations WHERE budget_id=$1`, [this.budgetId])).rows[0];
    if (!sums) throw unavailable();
    return { settled: readMicroUsd(row.settled_micro_usd), reserved: readMicroUsd(row.reserved_micro_usd),
      halted: row.halted, outstandingOperations: Number(sums.outstanding), probeSettled: readMicroUsd(sums.probe_settled), probeReserved: readMicroUsd(sums.probe_reserved) };
  }
  private async operation(tx: DbTransaction, value: BudgetReservation): Promise<OperationRow> {
    if (value.budgetId !== this.budgetId) throw unavailable();
    const row = (await tx.query<OperationRow>("SELECT * FROM unfurl.ai_provider_operations WHERE id=$1 AND budget_id=$2 FOR UPDATE", [value.id, this.budgetId])).rows[0];
    if (!row || row.request_digest !== value.requestDigest || row.reserved_micro_usd !== value.amountMicroUsd) throw unavailable();
    return row;
  }
  private async derivedReceipt(tx:DbTransaction,operationId:string,saved:ReceiptRow):Promise<ProviderResponseReceipt>{
    const original=receipt(saved);
    const repair=(await tx.query<{response_digest:string;normalizer_version:string;evidence_digest:string;native_usage:JsonObject;source_evidence:JsonObject}>(
      "SELECT response_digest,normalizer_version,evidence_digest,native_usage,source_evidence FROM unfurl.ai_provider_response_normalizations WHERE operation_id=$1 AND normalizer_version=$2",[operationId,NATIVE_USAGE_VERSION])).rows[0];
    if(!repair)return original;
    if(repair.response_digest!==original.responseDigest||repair.evidence_digest!==jsonDigest({responseDigest:repair.response_digest,normalizerVersion:repair.normalizer_version,nativeUsage:repair.native_usage,sourceEvidence:repair.source_evidence}))throw unavailable();
    const normalized=normalizeNativeUsage(repair.native_usage);
    if(["promptTokens","completionTokens","totalTokens","reasoningTokens","cachedPromptTokens","costUsd"].some(key=>normalized[key as keyof typeof normalized]!==original.usage[key]))throw unavailable();
    return{...original,nativeUsage:repair.native_usage,normalizationEvidenceDigest:repair.evidence_digest};
  }
  private async entry(tx: DbTransaction, operationId: string, kind: "reserve" | "release" | "settle" | "reconcile",
    held: bigint, spent: bigint, digest: string | null, key = `${operationId}:${kind}`): Promise<void> {
    await tx.query(`INSERT INTO unfurl.ai_budget_entries
      (id,budget_id,operation_id,effect_key,kind,reserved_delta_micro_usd,settled_delta_micro_usd,evidence_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), this.budgetId, operationId, key, kind, held.toString(), spent.toString(), digest]);
    await tx.query(`UPDATE unfurl.ai_budgets SET reserved_micro_usd=reserved_micro_usd+$2,
      settled_micro_usd=settled_micro_usd+$3, revision=revision+1,updated_at=now() WHERE id=$1`,
    [this.budgetId, held.toString(), spent.toString()]);
  }
  async assertAvailable(options: { probe: boolean }): Promise<void> {
    await this.transaction(async (tx) => {
      const state = await this.state(tx, await this.lock(tx));
      if (!canReserve(state, 1n, options.probe).allowed) throw new ProviderFailure("budget_exhausted");
    });
  }
  async recover(context: BudgetOperationContext, requestDigest: string): Promise<{ reservation: BudgetReservation; receipt: ProviderResponseReceipt } | null> {
    return this.transaction(async (tx) => {
      await this.lock(tx);
      const row = (await tx.query<OperationRow>("SELECT * FROM unfurl.ai_provider_operations WHERE logical_operation_id=$1 AND attempt=$2 FOR UPDATE", [context.logicalOperationId, context.attempt])).rows[0];
      if (!row) return null;
      if (row.id !== context.reservationId || row.budget_id !== this.budgetId || row.request_digest !== requestDigest ||
        row.run_step_id !== context.runStepId || (row.purpose === "capability_probe") !== context.probe) throw unavailable();
      const saved = (await tx.query<ReceiptRow>("SELECT * FROM unfurl.ai_provider_responses WHERE operation_id=$1", [row.id])).rows[0];
      if (saved) return { reservation: reservation(row), receipt: await this.derivedReceipt(tx,row.id,saved) };
      if (row.state !== "reserved") throw unavailable();
      return null;
    });
  }
  async reserve(request: ReserveRequest): Promise<BudgetReservation> {
    const amount = readMicroUsd(request.amountMicroUsd);
    if (amount === 0n || request.probe !== (request.purpose === "capability_probe") ||
      jsonDigest(request.rateCard, 64 * 1024) !== request.rateCardDigest) throw unavailable();
    return this.transaction(async (tx) => {
      const campaign = await this.lock(tx);
      const prior = (await tx.query<OperationRow>(`SELECT * FROM unfurl.ai_provider_operations
        WHERE logical_operation_id=$1 AND attempt=$2 FOR UPDATE`, [request.logicalOperationId, request.attempt])).rows[0];
      if (prior) {
        if (prior.id !== request.reservationId || prior.budget_id !== this.budgetId || prior.request_digest !== request.requestDigest ||
          prior.purpose !== request.purpose || prior.reserved_micro_usd !== request.amountMicroUsd ||
          prior.run_step_id !== request.runStepId || prior.rate_card_digest !== request.rateCardDigest ||
          canonicalJson(prior.rate_card) !== canonicalJson(request.rateCard)) throw unavailable();
        return reservation(prior);
      }
      if (!canReserve(await this.state(tx, campaign), amount, request.probe).allowed) throw new ProviderFailure("budget_exhausted");
      const row = (await tx.query<OperationRow>(`INSERT INTO unfurl.ai_provider_operations
        (id,budget_id,logical_operation_id,attempt,run_step_id,request_digest,purpose,state,reserved_micro_usd,model_id,provider_tag,rate_card_digest,rate_card)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10,$11,$12) RETURNING *`,
      [request.reservationId, this.budgetId, request.logicalOperationId, request.attempt, request.runStepId, request.requestDigest,
        request.purpose, request.amountMicroUsd, MODEL_ID, PROVIDER_TAG, request.rateCardDigest, JSON.stringify(request.rateCard)])).rows[0];
      if (!row) throw unavailable();
      await this.entry(tx, row.id, "reserve", amount, 0n, request.requestDigest);
      return reservation(row);
    });
  }
  async claimDispatch(value: BudgetReservation): Promise<DispatchDecision> {
    return this.transaction(async (tx) => {
      const campaign = await this.lock(tx);
      const row = await this.operation(tx, value);
      const saved = (await tx.query<ReceiptRow>("SELECT * FROM unfurl.ai_provider_responses WHERE operation_id=$1", [row.id])).rows[0];
      if (saved) return { kind: "replay", receipt: await this.derivedReceipt(tx,row.id,saved) };
      if (row.state !== "reserved" || campaign.halted) throw unavailable();
      await tx.query("UPDATE unfurl.ai_provider_operations SET state='dispatched',dispatched_at=now(),updated_at=now() WHERE id=$1", [row.id]);
      return { kind: "dispatch" };
    });
  }
  async recordResponse(value: BudgetReservation, response: ProviderResponseReceipt, cost: string | null): Promise<void> {
    const actual = cost === null ? null : readMicroUsd(cost);
    canonicalJson(response.usage, 64 * 1024);
    canonicalJson(response.result, 2 * 1024 * 1024);
    await this.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.operation(tx, value);
      if (!["dispatched", "unknown", "settled"].includes(row.state)) throw unavailable();
      const prior = (await tx.query<ReceiptRow>("SELECT * FROM unfurl.ai_provider_responses WHERE operation_id=$1", [row.id])).rows[0];
      if (prior) {
        if (canonicalJson(receipt(prior), 3 * 1024 * 1024) !== canonicalJson(response, 3 * 1024 * 1024)) throw unavailable();
        // Initial accounting is immutable. Later verified costs use reconcile(), with separate evidence.
        if (row.state === "settled" && actual !== null && row.actual_micro_usd !== actual.toString()) throw unavailable();
        return;
      }
      await tx.query(`INSERT INTO unfurl.ai_provider_responses
        (operation_id,provider_request_id,response_digest,reported_cost_usd,usage,result) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, response.providerRequestId, response.responseDigest, response.reportedCostUsd, JSON.stringify(response.usage), JSON.stringify(response.result)]);
      await tx.query("UPDATE unfurl.ai_provider_operations SET provider_request_id=$2,updated_at=now() WHERE id=$1", [row.id, response.providerRequestId]);
      if (actual === null) {
        await tx.query("UPDATE unfurl.ai_provider_operations SET state='unknown',updated_at=now() WHERE id=$1", [row.id]);
        const result=response.result;
        if(result!==null&&typeof result==="object"&&!Array.isArray(result)&&result.kind==="http_error"&&result.httpStatus===400){
          await tx.query("SELECT unfurl.record_ai_provider_terminal_http_400($1,$2)",[row.id,response.responseDigest]);
        }
      } else await this.settle(tx, row, actual, response.responseDigest);
    });
  }
  private async settle(tx: DbTransaction, row: OperationRow, actual: bigint, digest: string): Promise<void> {
    const held = readMicroUsd(row.reserved_micro_usd);
    await tx.query("UPDATE unfurl.ai_provider_operations SET state='settled',actual_micro_usd=$2,settled_at=now(),updated_at=now() WHERE id=$1", [row.id, actual.toString()]);
    await this.entry(tx, row.id, "settle", -held, actual, digest);
    if (actual > held) await tx.query("UPDATE unfurl.ai_budgets SET halted=true,revision=revision+1,updated_at=now() WHERE id=$1", [this.budgetId]);
  }
  async markUnknown(value: BudgetReservation, failure: ProviderFailureCode): Promise<void> {
    await this.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.operation(tx, value);
      if (row.state === "dispatched" || row.state === "unknown") {
        await tx.query("UPDATE unfurl.ai_provider_operations SET state='unknown',safe_failure_code=$2,updated_at=now() WHERE id=$1", [row.id, failure]);
      }
    });
  }
  async releaseUnsent(value: BudgetReservation): Promise<void> {
    await this.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.operation(tx, value);
      if (row.state === "released") return;
      if (row.state !== "reserved") throw unavailable();
      await tx.query("UPDATE unfurl.ai_provider_operations SET state='released',updated_at=now() WHERE id=$1", [row.id]);
      await this.entry(tx, row.id, "release", -readMicroUsd(row.reserved_micro_usd), 0n, null);
    });
  }
  async halt(_reason: "price_mismatch" | "usage_bound_exceeded" | "accounting_mismatch"): Promise<void> {
    if (!["price_mismatch", "usage_bound_exceeded", "accounting_mismatch"].includes(_reason)) throw unavailable();
    await this.transaction(async (tx) => {
      await this.lock(tx);
      await tx.query("UPDATE unfurl.ai_budgets SET halted=true,revision=revision+1,updated_at=now() WHERE id=$1", [this.budgetId]);
    });
  }
  async reconciliationTarget(operationId: string): Promise<{
    reservation: BudgetReservation; rateCard: unknown; purpose: string; receipt: ProviderResponseReceipt | null;
  } | null> {
    return this.transaction(async (tx) => {
      const row = (await tx.query<OperationRow>("SELECT * FROM unfurl.ai_provider_operations WHERE id=$1 AND budget_id=$2", [operationId, this.budgetId])).rows[0];
      if (!row) return null;
      const saved = (await tx.query<ReceiptRow>("SELECT * FROM unfurl.ai_provider_responses WHERE operation_id=$1", [row.id])).rows[0];
      return { reservation: reservation(row), rateCard: row.rate_card, purpose: row.purpose, receipt: saved ? await this.derivedReceipt(tx,row.id,saved) : null };
    });
  }
  /** Evidence must come from authenticated generation accounting, never a timer or estimate. */
  async reconcile(value: BudgetReservation, evidence: { providerRequestId: string; digest: string; finalCostMicroUsd: string }): Promise<void> {
    const actual = readMicroUsd(evidence.finalCostMicroUsd);
    await this.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.operation(tx, value);
      const saved = (await tx.query<{ provider_request_id: string | null }>("SELECT provider_request_id FROM unfurl.ai_provider_operations WHERE id=$1", [row.id])).rows[0];
      if (!saved?.provider_request_id || saved.provider_request_id !== evidence.providerRequestId || !/^[a-f0-9]{64}$/.test(evidence.digest)) throw unavailable();
      const key = `${row.id}:reconcile:${evidence.digest}`;
      if ((await tx.query("SELECT id FROM unfurl.ai_budget_entries WHERE effect_key=$1", [key])).rowCount) return;
      if (row.state === "unknown" || row.state === "dispatched") {
        await this.settle(tx, row, actual, evidence.digest);
        await this.entry(tx, row.id, "reconcile", 0n, 0n, evidence.digest, key);
      } else if (row.state === "settled" && row.actual_micro_usd !== null) {
        const delta = actual - readMicroUsd(row.actual_micro_usd);
        await tx.query("UPDATE unfurl.ai_provider_operations SET actual_micro_usd=$2,updated_at=now() WHERE id=$1", [row.id, actual.toString()]);
        await this.entry(tx, row.id, "reconcile", 0n, delta, evidence.digest, key);
        if (delta !== 0n) await tx.query("UPDATE unfurl.ai_budgets SET halted=true,revision=revision+1,updated_at=now() WHERE id=$1", [this.budgetId]);
      } else throw unavailable();
    });
  }
}
