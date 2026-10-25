import "server-only";

export const CAMPAIGN_LIMIT_MICRO_USD = 10_000_000n;
export const SPENDABLE_LIMIT_MICRO_USD = 9_500_000n;
export const PROBE_LIMIT_MICRO_USD = 750_000n;
export const MAX_CONCURRENT_OPERATIONS = 2;

export interface DecimalRatio { numerator: bigint; denominator: bigint }

/** Decimal/scientific input is parsed exactly; no binary floating arithmetic. */
export function decimalRatio(value: string): DecimalRatio {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 100) throw new RangeError("Invalid nonnegative decimal");
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) throw new RangeError("Decimal exponent is out of bounds");
  const fraction = match[2] ?? "";
  const scale = fraction.length - exponent;
  const digits = BigInt(`${match[1]}${fraction}`);
  return scale >= 0 ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}

export function ceilingDivision(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("Invalid nonnegative ratio");
  return (numerator + denominator - 1n) / denominator;
}

export function usdToMicroUsdCeil(value: string): bigint {
  const ratio = decimalRatio(value);
  return ceilingDivision(ratio.numerator * 1_000_000n, ratio.denominator);
}

export function tokenCostMicroUsdCeil(tokens: number, usdPerToken: string): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new RangeError("Invalid token count");
  const ratio = decimalRatio(usdPerToken);
  return ceilingDivision(BigInt(tokens) * ratio.numerator * 1_000_000n, ratio.denominator);
}

export function decimalAtMost(value: string, ceiling: string): boolean {
  const left = decimalRatio(value);
  const right = decimalRatio(ceiling);
  return left.numerator * right.denominator <= right.numerator * left.denominator;
}

export function readMicroUsd(value: string): bigint {
  if (!/^(0|[1-9]\d{0,19})$/.test(value)) throw new RangeError("Invalid integer microUSD");
  const amount = BigInt(value);
  if (amount > 9_223_372_036_854_775_807n) throw new RangeError("Integer microUSD exceeds database bigint");
  return amount;
}

