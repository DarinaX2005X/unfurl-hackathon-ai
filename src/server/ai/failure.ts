import "server-only";
import { ServiceFault } from "../auth/errors";

export const PROVIDER_FAILURE_CODES = [
  "unavailable", "timeout", "rate_limited", "invalid_output", "refused", "budget_exhausted", "cancelled",
] as const;
export type ProviderFailureCode = typeof PROVIDER_FAILURE_CODES[number];

/** Deliberately contains no upstream message, response body, prompt or credential. */
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode, readonly retryAfterMs: number | null = null) {
    super(`provider.${code}`);
    this.name = "ProviderFailure";
  }
}

/** Null is an intentional cancellation: persist cancelled state instead of an upstream error. */
export function publicProviderFault(error: unknown): ServiceFault | null {
  const code = error instanceof ProviderFailure ? error.code : "unavailable";
  if (code === "cancelled") return null;
  if (code === "rate_limited") return new ServiceFault(429, "rate_limited", "generation.rateLimited", true);
  if (code === "budget_exhausted") return new ServiceFault(503, "service_unavailable", "generation.budgetExhausted", false);
  if (code === "invalid_output" || code === "refused") {
    return new ServiceFault(502, "generation_failed", "generation.invalidResponse", false);
  }
  return new ServiceFault(503, "service_unavailable", code === "timeout" ? "generation.timeout" : "generation.unavailable", true);
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.min(60_000, Math.max(0, Math.ceil(seconds))) : null;
}

