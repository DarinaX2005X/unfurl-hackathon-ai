import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canReserve, settlementDelta, type BudgetState } from "../../src/server/budget/calculations";
import { PostgresBudget } from "../../src/server/budget/postgres";
import { jsonDigest } from "../../src/server/ai/json";
import type { DbTransaction } from "../../src/server/db";
import type { ReserveRequest } from "../../src/server/budget/ports";

const empty: BudgetState = { settled: 0n, reserved: 0n, probeSettled: 0n, probeReserved: 0n, outstandingOperations: 0, halted: false };

describe("budget admission policy (pure logic, not a durable concurrency test)", () => {
  it("admits the exact spendable boundary while retaining the campaign safety reserve", () => {
    expect(canReserve({ ...empty, settled: 9_400_000n }, 100_000n, false)).toEqual({ allowed: true });
    expect(canReserve({ ...empty, settled: 9_400_000n }, 100_001n, false)).toEqual({ allowed: false, reason: "campaign_limit" });
  });

  it("counts existing held reservations across calls instead of giving a new run a new limit", () => {
    expect(canReserve({ ...empty, settled: 9_000_000n, reserved: 400_000n, outstandingOperations: 1 }, 100_001n, false))
      .toEqual({ allowed: false, reason: "campaign_limit" });
  });

  it("refuses a third outstanding operation even with unspent budget", () => {
    expect(canReserve({ ...empty, reserved: 2n, outstandingOperations: 2 }, 1n, false)).toEqual({ allowed: false, reason: "concurrency" });
  });

  it("applies the probe envelope inside the same campaign ceiling", () => {
    expect(canReserve({ ...empty, probeSettled: 2_450_000n }, 50_000n, true)).toEqual({ allowed: true });
    expect(canReserve({ ...empty, probeSettled: 2_450_000n, probeReserved: 49_999n }, 2n, true)).toEqual({ allowed: false, reason: "probe_limit" });
    expect(canReserve({ ...empty, settled: 8_700_000n }, 50_000n, true)).toEqual({ allowed: true });
    expect(canReserve({ ...empty, settled: 8_700_000n }, 50_001n, true)).toEqual({ allowed: false, reason: "campaign_limit" });
    expect(canReserve({ ...empty, settled: 9_499_999n }, 2n, true)).toEqual({ allowed: false, reason: "campaign_limit" });
  });

  it("does not admit into a halted campaign or accept corrupt counters", () => {
    expect(canReserve({ ...empty, halted: true }, 1n, false)).toEqual({ allowed: false, reason: "halted" });
    expect(() => canReserve({ ...empty, reserved: -1n }, 1n, false)).toThrow(RangeError);
    expect(() => canReserve(empty, 0n, false)).toThrow(RangeError);
  });

  it("records a real cost above its bound and requests a halt", () => {
    expect(settlementDelta(100n, 101n)).toEqual({ reservedDelta: -100n, settledDelta: 101n, halt: true });
    expect(settlementDelta(100n, 60n)).toEqual({ reservedDelta: -100n, settledDelta: 60n, halt: false });
  });
});

describe("budget adapter denial classification", () => {
  const rateCard = { model: "moonshotai/kimi-k2.6", provider: "digitalocean", policyVersion: "kimi-digitalocean-v1" };
  const request: ReserveRequest = { reservationId: "00000000-0000-4000-8000-000000000001", logicalOperationId: "00000000-0000-4000-8000-000000000002",
    attempt: 1, runStepId: null, probe: false, purpose: "curriculum", amountMicroUsd: "1", requestDigest: "a".repeat(64), rateCard, rateCardDigest: jsonDigest(rateCard) };
  it.each([
    { reason: "concurrency", state: { ...empty, outstandingOperations: 2 }, probe: false, code: "rate_limited" },
    { reason: "campaign limit", state: { ...empty, settled: 9_500_000n }, probe: false, code: "budget_exhausted" },
    { reason: "probe limit", state: { ...empty, probeSettled: 2_500_000n }, probe: true, code: "budget_exhausted" },
    { reason: "halt", state: { ...empty, halted: true, outstandingOperations: 2 }, probe: false, code: "budget_exhausted" },
  ])("classifies $reason consistently before any reservation write", async ({ state, probe, code }) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM unfurl.ai_budgets")) return { rows: [{ id: request.reservationId, settled_micro_usd: state.settled.toString(), reserved_micro_usd: state.reserved.toString(), halted: state.halted }] };
      if (sql.includes("count(*) FILTER")) return { rows: [{ outstanding: String(state.outstandingOperations), probe_settled: state.probeSettled.toString(), probe_reserved: state.probeReserved.toString() }] };
      if (sql.includes("WHERE logical_operation_id")) return { rows: [] };
      throw new Error("Unexpected query; rejected admission must not write");
    });
    const budget = new PostgresBudget(request.reservationId, work => work({ query } as unknown as DbTransaction));
    await expect(budget.assertAvailable({ probe })).rejects.toMatchObject({ code });
    await expect(budget.reserve({ ...request, probe, purpose: probe ? "capability_probe" : "curriculum" })).rejects.toMatchObject({ code });
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
});

