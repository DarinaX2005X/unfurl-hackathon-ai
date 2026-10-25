import "server-only";
import { PROVIDER_PRICE_CAP, SEARCH_PRICE_USD } from "../ai/constants";
import { MAX_CONCURRENT_OPERATIONS, PROBE_LIMIT_MICRO_USD, SPENDABLE_LIMIT_MICRO_USD, tokenCostMicroUsdCeil, usdToMicroUsdCeil } from "./money";

export interface ReservationBounds {
  contextTokens: number;
  outputTokens: number;
  /** The bounded server search has an initial and a final model inference. */
  inferencePasses: 1 | 2;
  searches: 0 | 1;
}

export function worstCaseMicroUsd(bounds: ReservationBounds): bigint {
  if (bounds.contextTokens <= 0 || bounds.outputTokens <= 0 || bounds.outputTokens > bounds.contextTokens ||
      ![1, 2].includes(bounds.inferencePasses) || ![0, 1].includes(bounds.searches) ||
      (bounds.searches === 1 && bounds.inferencePasses !== 2)) throw new RangeError("Invalid reservation bounds");
  // Reserve the full endpoint context for EACH inference, including its generated tool input.
  // This is intentionally conservative until native token counting is verified.
  const model = BigInt(bounds.inferencePasses) * (
    tokenCostMicroUsdCeil(bounds.contextTokens, PROVIDER_PRICE_CAP.prompt) +
    tokenCostMicroUsdCeil(bounds.outputTokens, PROVIDER_PRICE_CAP.completion)
  );
  const tool = BigInt(bounds.searches) * usdToMicroUsdCeil(SEARCH_PRICE_USD);
  return model + tool;
}

export interface BudgetState {
  settled: bigint; reserved: bigint; probeSettled: bigint; probeReserved: bigint;
  outstandingOperations: number; halted: boolean;
}

export type AdmissionDecision = { allowed: true } | { allowed: false; reason: "halted" | "concurrency" | "campaign_limit" | "probe_limit" };

/** Used inside the locked durable transaction; this pure function is not a ledger. */
export function canReserve(state: BudgetState, amount: bigint, isProbe: boolean): AdmissionDecision {
  if (amount <= 0n || [state.settled, state.reserved, state.probeSettled, state.probeReserved].some((value) => value < 0n) ||
      !Number.isSafeInteger(state.outstandingOperations) || state.outstandingOperations < 0) throw new RangeError("Invalid budget state");
  if (state.halted) return { allowed: false, reason: "halted" };
  if (state.outstandingOperations >= MAX_CONCURRENT_OPERATIONS) return { allowed: false, reason: "concurrency" };
  if (state.settled + state.reserved + amount > SPENDABLE_LIMIT_MICRO_USD) return { allowed: false, reason: "campaign_limit" };
  if (isProbe && state.probeSettled + state.probeReserved + amount > PROBE_LIMIT_MICRO_USD) return { allowed: false, reason: "probe_limit" };
  return { allowed: true };
}

export function settlementDelta(reserved: bigint, actual: bigint): { reservedDelta: bigint; settledDelta: bigint; halt: boolean } {
  if (reserved <= 0n || actual < 0n) throw new RangeError("Invalid settlement");
  return { reservedDelta: -reserved, settledDelta: actual, halt: actual > reserved };
}

