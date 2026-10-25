import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decimalAtMost, decimalRatio, readMicroUsd, tokenCostMicroUsdCeil, usdToMicroUsdCeil } from "../../src/server/budget/money";
import { worstCaseMicroUsd } from "../../src/server/budget/calculations";

describe("exact dollar accounting", () => {
  it("rounds upward without losing the digit just beyond a microUSD boundary", () => {
    expect(usdToMicroUsdCeil("0.00000100000000000000000001")).toBe(2n);
    expect(usdToMicroUsdCeil("0.000001")).toBe(1n);
    expect(usdToMicroUsdCeil("1e-7")).toBe(1n);
    expect(usdToMicroUsdCeil("10.00")).toBe(10_000_000n);
    expect(usdToMicroUsdCeil("0")).toBe(0n);
  });

  it("compares exact per-token rate caps without a floating-point equality allowance", () => {
    expect(decimalAtMost("0.00000057", "0.00000060")).toBe(true);
    expect(decimalAtMost("6e-7", "0.00000060")).toBe(true);
    expect(decimalAtMost("0.00000060000000000000000001", "0.00000060")).toBe(false);
    expect(decimalAtMost("0.00000260000000000000000001", "0.00000260")).toBe(false);
  });

  it("rounds each bounded billable token dimension conservatively", () => {
    expect(tokenCostMicroUsdCeil(262144, "0.00000060")).toBe(157287n);
    expect(tokenCostMicroUsdCeil(2048, "0.00000260")).toBe(5325n);
    expect(tokenCostMicroUsdCeil(1, "0.00000057")).toBe(1n);
    expect(tokenCostMicroUsdCeil(0, "0.00000057")).toBe(0n);
  });

  it.each(["-1", "NaN", "Infinity", "1x", "1e999999", "", ".5", "1,5"])("rejects malformed or unbounded dollar value %s", (value) => {
    expect(() => decimalRatio(value)).toThrow(RangeError);
  });

  it("rejects fractional/unsafe token counts and noncanonical database money", () => {
    expect(() => tokenCostMicroUsdCeil(1.5, "0.01")).toThrow(RangeError);
    expect(() => tokenCostMicroUsdCeil(Number.MAX_SAFE_INTEGER + 1, "0.01")).toThrow(RangeError);
    for (const value of ["-1", "01", "1.0", "1e6", "9223372036854775808"]) {
      expect(() => readMicroUsd(value)).toThrow(RangeError);
    }
    expect(readMicroUsd("9500000")).toBe(9_500_000n);
  });
});

describe("conservative request bounds", () => {
  it("reserves the full endpoint context rather than using a character/token guess", () => {
    expect(worstCaseMicroUsd({ contextTokens: 262144, outputTokens: 2048, inferencePasses: 1, searches: 0 })).toBe(162612n);
  });

  it("includes both bounded search model passes and the exact Parallel advanced fee", () => {
    expect(worstCaseMicroUsd({ contextTokens: 262144, outputTokens: 2048, inferencePasses: 2, searches: 1 })).toBe(330224n);
  });

  it("refuses a search reservation missing the second inference or impossible output bounds", () => {
    expect(() => worstCaseMicroUsd({ contextTokens: 262144, outputTokens: 2048, inferencePasses: 1, searches: 1 })).toThrow(RangeError);
    expect(() => worstCaseMicroUsd({ contextTokens: 1, outputTokens: 2, inferencePasses: 1, searches: 0 })).toThrow(RangeError);
  });
});

