import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canReserve, settlementDelta, type BudgetState } from "../../src/server/budget/calculations";

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

