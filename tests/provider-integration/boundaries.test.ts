import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canonicalJson, jsonDigest, parseProviderJson } from "../../src/server/ai/json";
import { ProviderFailure, publicProviderFault, retryAfterMilliseconds } from "../../src/server/ai/failure";

describe("private provider boundary", () => {
  it("retains exact JSON cost literals including scientific notation", () => {
    const parsed = parseProviderJson('{"usage":{"cost":0.00000100000000000000000001,"upstream_inference_cost":1e-9},"total_cost":0.2}');
    expect(parsed).toEqual({ usage: { cost: "0.00000100000000000000000001", upstream_inference_cost: "1e-9" }, total_cost: "0.2" });
  });

  it("does not rewrite cost-like text inside quoted completion content", () => {
    const raw = '{"content":"Example: \\"cost\\": 1.25","usage":{"cost":"0.01"}}';
    expect(parseProviderJson(raw)).toEqual({ content: 'Example: "cost": 1.25', usage: { cost: "0.01" } });
  });

  it("recognizes escaped JSON property names and refuses malformed JSON", () => {
    expect(parseProviderJson('{"usage":{"co\\u0073t":0.0000001}}')).toEqual({ usage: { cost: "0.0000001" } });
    for (const raw of ['{"usage":{"cost":01}}', '{"cost":NaN}', '{"a":"unterminated}']) {
      expect(() => parseProviderJson(raw)).toThrow(ProviderFailure);
    }
  });

  it("uses stable bounded request identity and distinguishes array order", () => {
    expect(jsonDigest({ b: 2, a: { d: 4, c: 3 } })).toBe(jsonDigest({ a: { c: 3, d: 4 }, b: 2 }));
    expect(jsonDigest([1, 2])).not.toBe(jsonDigest([2, 1]));
    expect(() => canonicalJson({ input: "a".repeat(100) }, 20)).toThrow(ProviderFailure);
  });

  it("rejects cycles, sparse arrays, nonfinite values and dangerous object keys", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [cycle, new Array(2), { value: Infinity }, JSON.parse('{"__proto__":{}}') as unknown]) {
      expect(() => canonicalJson(value)).toThrow(ProviderFailure);
    }
  });

  it("does not expose upstream error messages and keeps cancellation distinct", () => {
    const fault = publicProviderFault(new Error("private upstream payload"));
    expect(fault?.messageKey).toBe("generation.unavailable");
    expect(fault?.toApiError("request-id")).not.toEqual(expect.objectContaining({ message: "private upstream payload" }));
    expect(publicProviderFault(new ProviderFailure("cancelled"))).toBeNull();
    expect(publicProviderFault(new ProviderFailure("budget_exhausted"))).toMatchObject({ status: 503, retryable: false, messageKey: "generation.budgetExhausted" });
  });

  it("bounds explicit retry advice without performing a hidden paid retry", () => {
    expect(retryAfterMilliseconds("2")).toBe(2000);
    expect(retryAfterMilliseconds("1000")).toBe(60000);
    expect(retryAfterMilliseconds("invalid")).toBeNull();
  });
});

