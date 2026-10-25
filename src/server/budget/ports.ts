import "server-only";
import type { JsonObject, JsonValue } from "../../domain/common";
import type { ProviderFailureCode } from "../ai/failure";

export type BillablePurpose = "turn_planning" | "source_extraction" | "curriculum" | "module_knowledge" |
  "task_authoring" | "content_review" | "rubric_grading" | "activity_dialogue" | "web_search" | "capability_probe";

/** Created by the executing durable step. It cannot select a campaign or a price. */
export interface BudgetOperationContext {
  reservationId: string;
  logicalOperationId: string;
  attempt: number;
  runStepId: string | null;
  probe: boolean;
}

export interface ReserveRequest extends BudgetOperationContext {
  requestDigest: string;
  purpose: BillablePurpose;
  amountMicroUsd: string;
  rateCardDigest: string;
  rateCard: JsonObject;
}

export interface BudgetReservation {
  id: string;
  budgetId: string;
  requestDigest: string;
  amountMicroUsd: string;
  state: "reserved" | "dispatched" | "unknown" | "settled" | "released";
}

export interface ProviderResponseReceipt {
  providerRequestId: string | null;
  responseDigest: string;
  reportedCostUsd: string | null;
  usage: JsonObject;
  result: JsonValue | null;
}

export type DispatchDecision = { kind: "dispatch" } | { kind: "replay"; receipt: ProviderResponseReceipt };

/** Implementations must serialize on the single campaign row and persist every transition. */
export interface BudgetPort {
  assertAvailable(options: { probe: boolean }): Promise<void>;
  reserve(request: ReserveRequest): Promise<BudgetReservation>;
  claimDispatch(reservation: BudgetReservation): Promise<DispatchDecision>;
  /** Receipt and settlement/unknown state commit atomically before success leaves the adapter. */
  recordResponse(reservation: BudgetReservation, receipt: ProviderResponseReceipt, confirmedCostMicroUsd: string | null): Promise<void>;
  markUnknown(reservation: BudgetReservation, failure: ProviderFailureCode): Promise<void>;
  releaseUnsent(reservation: BudgetReservation): Promise<void>;
  halt(reason: "price_mismatch" | "usage_bound_exceeded" | "accounting_mismatch"): Promise<void>;
}

