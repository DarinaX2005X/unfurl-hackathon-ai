import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { OpenRouterAccounting } from "../../src/server/ai/accounting";
import { MODEL_ID } from "../../src/server/ai/constants";
import type { PostgresBudget } from "../../src/server/budget/postgres";

function harness(options: { search?: boolean; total?: number; engine?: string } = {}) {
  const total = options.total ?? (options.search ? 0.005081 : 0.000081);
  const budget: Pick<PostgresBudget, "reconciliationTarget" | "reconcile" | "halt"> = {
    reconciliationTarget: vi.fn(async () => ({
      reservation: { id: "op", budgetId: "campaign", requestDigest: "a".repeat(64), amountMicroUsd: "10000", state: "unknown" as const },
      rateCard: { contextTokens: 262144, pricing: { prompt: "0.00000057", completion: "0.0000024" } }, purpose: "capability_probe",
      receipt: { providerRequestId: "gen-test", responseDigest: "b".repeat(64), reportedCostUsd: String(total), result: {},
        usage: { searchRequests: options.search ? 1 : 0 } },
    })),
    reconcile: vi.fn(async () => undefined), halt: vi.fn(async () => undefined),
  };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: {
    id: "gen-test", model: MODEL_ID, provider_name: "DigitalOcean", total_cost: total,
    finish_reason: "stop", cancelled: false, native_tokens_prompt: 100, native_tokens_completion: 10,
    native_tokens_cached: 0, num_search_results: options.search ? 5 : 0, web_search_engine: options.engine ?? "parallel", is_byok: false,
  } })));
  return { budget, fetcher, accounting: new OpenRouterAccounting(budget, () => "test-key", fetcher) };
}
describe("authenticated generation accounting", () => {
  it("settles the provider's final decimal charge once through the durable ledger", async () => {
    const h = harness();
    expect(await h.accounting.reconcile("op", new AbortController().signal)).toMatchObject({ settled: true, searchFeeVerified: false });
    expect(h.budget.reconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ finalCostMicroUsd: "81", providerRequestId: "gen-test" }));
  });
  it("requires the real engine and native usage to establish that one search fee is included", async () => {
    const h = harness({ search: true });
    expect(await h.accounting.reconcile("op", new AbortController().signal)).toMatchObject({ settled: true, searchFeeVerified: true });
    expect(h.budget.reconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ finalCostMicroUsd: "5081" }));
    const missingFee = harness({ search: true, total: 0.000081 });
    expect(await missingFee.accounting.reconcile("op", new AbortController().signal)).toMatchObject({ settled: false });
    expect(missingFee.budget.reconcile).not.toHaveBeenCalled();
    const wrongEngine = harness({ search: true, engine: "exa" });
    expect(await wrongEngine.accounting.reconcile("op", new AbortController().signal)).toMatchObject({ settled: false });
  });
  it("retains unknown state when generation metadata is not yet available", async () => {
    const h = harness(); h.fetcher.mockResolvedValue(new Response("not ready", { status: 404 }));
    expect(await h.accounting.reconcile("op", new AbortController().signal)).toEqual({ settled: false, searchFeeVerified: false, evidence: null });
    expect(h.budget.reconcile).not.toHaveBeenCalled();
  });
});
