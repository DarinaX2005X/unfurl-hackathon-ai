import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../domain/common";
import type { PostgresBudget } from "../budget/postgres";
import { decimalRatio, tokenCostMicroUsdCeil, usdToMicroUsdCeil } from "../budget/money";
import { MODEL_ID, OPENROUTER_BASE_URL, SEARCH_PRICE_USD } from "./constants";
import { ProviderFailure } from "./failure";
import { boundedResponseText } from "./http";
import { jsonDigest, parseProviderJson } from "./json";
import {NativeUsageSchema} from "./native-usage";
import {verifyNativeSearchAccounting} from "./search-accounting";

const count = z.number().int().nonnegative().max(10_000_000);
const metadataSchema = z.object({ data: z.object({
  id: z.string().regex(/^gen-[0-9A-Za-z-]+$/), model: z.string().max(200), provider_name: z.literal("DigitalOcean"),
  total_cost: z.string(), finish_reason: z.string().min(1), cancelled: z.boolean(),
  native_tokens_prompt: count, native_tokens_completion: count, native_tokens_cached: count.nullable().optional(),
  num_search_results: count.nullable().optional(), web_search_engine: z.string().nullable().optional(),
  upstream_inference_cost: z.string().nullable().optional(), is_byok: z.literal(false),
}) });
function equalDecimal(a: string, b: string): boolean {
  const left = decimalRatio(a); const right = decimalRatio(b);
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

/** A GET cannot release a hold until authenticated final accounting matches the original operation. */
export class OpenRouterAccounting {
  constructor(private readonly budget: Pick<PostgresBudget, "reconciliationTarget" | "reconcile" | "halt">,
    private readonly apiKey: () => string | undefined, private readonly fetcher: typeof fetch = fetch) {}
  async reconcile(operationId: string, signal: AbortSignal, options: { nativeOnly?: boolean } = {}): Promise<{ settled: boolean; searchFeeVerified: boolean; evidence: JsonObject | null }> {
    const target = await this.budget.reconciliationTarget(operationId);
    const id = target?.receipt?.providerRequestId;
    if (!target || !target.receipt || !id || !/^gen-[0-9A-Za-z-]{1,124}$/.test(id)) return { settled: false, searchFeeVerified: false, evidence: null };
    const savedResult=z.object({nativeUsage:NativeUsageSchema.optional(),finishReason:z.string(),failure:z.unknown(),annotations:z.array(z.unknown())}).safeParse(target.receipt.result);
    const native=NativeUsageSchema.safeParse(target.receipt.nativeUsage??(savedResult.success?savedResult.data.nativeUsage:undefined));
    if(native.success&&(native.data.server_tool_use_details?.web_search_requests??0)>0){
      const proof=savedResult.success?verifyNativeSearchAccounting(native.data,target.rateCard,{reportedCostUsd:target.receipt.reportedCostUsd,
        finishReason:savedResult.data.finishReason,failure:savedResult.data.failure,annotationCount:savedResult.data.annotations.length}):null;
      if(!proof)return{settled:false,searchFeeVerified:false,evidence:null};
      const evidence:JsonObject={...proof.evidence,operationId,providerRequestId:id,responseDigest:target.receipt.responseDigest,normalizationEvidenceDigest:target.receipt.normalizationEvidenceDigest??null};
      await this.budget.reconcile(target.reservation,{providerRequestId:id,digest:jsonDigest(evidence),finalCostMicroUsd:proof.costMicroUsd});
      return{settled:true,searchFeeVerified:true,evidence};
    }
    const key = options.nativeOnly ? undefined : this.apiKey();
    if (!key) return { settled: false, searchFeeVerified: false, evidence: null };
    let response: Response;
    try {
      response = await this.fetcher(OPENROUTER_BASE_URL + "/generation?id=" + encodeURIComponent(id), {
        headers: { Authorization: "Bearer " + key }, redirect: "error", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) { await response.body?.cancel(); return { settled: false, searchFeeVerified: false, evidence: null }; }
    } catch { return { settled: false, searchFeeVerified: false, evidence: null }; }
    let parsed: z.infer<typeof metadataSchema>;
    try { parsed = metadataSchema.parse(parseProviderJson(await boundedResponseText(response))); }
    catch { return { settled: false, searchFeeVerified: false, evidence: null }; }
    const data = parsed.data;
    if (data.id !== id) throw new ProviderFailure("unavailable");
    const endpoint=z.object({endpointName:z.string()}).safeParse(target.rateCard);
    const nativeModel=endpoint.success?/^DigitalOcean \| (moonshotai\/kimi-k2\.6-\d{8})$/.exec(endpoint.data.endpointName)?.[1]:undefined;
    if(data.model!==MODEL_ID&&data.model!==nativeModel)throw new ProviderFailure("unavailable");
    let actual: bigint;
    try { actual = usdToMicroUsdCeil(data.total_cost); } catch { return { settled: false, searchFeeVerified: false, evidence: null }; }
    const rate = z.object({ contextTokens: count, pricing: z.object({ prompt: z.string(), completion: z.string(), input_cache_read: z.string().optional() }) }).safeParse(target.rateCard);
    if (!rate.success) return { settled: false, searchFeeVerified: false, evidence: null };
    const searches = target.receipt.usage.searchRequests;
    const search = typeof searches === "number" && searches > 0;
    const passes = search ? 2 : 1;
    if (data.native_tokens_prompt > rate.data.contextTokens * passes || (search && searches !== 1)) {
      await this.budget.halt("usage_bound_exceeded");
      return { settled: false, searchFeeVerified: false, evidence: null };
    }
    let searchFeeVerified = false;
    if (search) {
      // Final billed total is the authority. Native counters independently check that the
      // fixed $0.005 fee is included once, not silently omitted or manually added twice.
      const cached = data.native_tokens_cached ?? 0;
      if (data.web_search_engine !== "parallel" || data.num_search_results == null || data.num_search_results < 1 ||
        data.num_search_results > 5 || cached > data.native_tokens_prompt || (cached > 0 && !rate.data.pricing.input_cache_read)) {
        return { settled: false, searchFeeVerified: false, evidence: null };
      }
      const noncached = tokenCostMicroUsdCeil(data.native_tokens_prompt - cached, rate.data.pricing.prompt);
      const cache = tokenCostMicroUsdCeil(cached, rate.data.pricing.input_cache_read ?? rate.data.pricing.prompt);
      const completion = tokenCostMicroUsdCeil(data.native_tokens_completion, rate.data.pricing.completion);
      const expectedCeiling = noncached + cache + completion + usdToMicroUsdCeil(SEARCH_PRICE_USD);
      // Three independently ceiled token dimensions can exceed a single rounded total by <3 microUSD.
      searchFeeVerified = actual <= expectedCeiling && expectedCeiling - actual <= 3n && actual >= usdToMicroUsdCeil(SEARCH_PRICE_USD);
      if (!searchFeeVerified) return { settled: false, searchFeeVerified: false, evidence: null };
    }
    const evidence: JsonObject = {
      operationId, providerRequestId: id, model: data.model, provider: data.provider_name, totalCostUsd: data.total_cost,
      promptTokens: data.native_tokens_prompt, completionTokens: data.native_tokens_completion,
      cachedTokens: data.native_tokens_cached ?? 0, searchResults: data.num_search_results ?? 0,
      searchEngine: data.web_search_engine ?? null, searchFeeVerified, finishReason: data.finish_reason, cancelled: data.cancelled,
    };
    if (target.receipt.reportedCostUsd !== null) {
      try {
        if (!equalDecimal(target.receipt.reportedCostUsd, data.total_cost)) await this.budget.halt("accounting_mismatch");
      } catch { await this.budget.halt("accounting_mismatch"); }
    }
    await this.budget.reconcile(target.reservation, { providerRequestId: id, digest: jsonDigest(evidence), finalCostMicroUsd: actual.toString() });
    return { settled: true, searchFeeVerified, evidence };
  }
}
