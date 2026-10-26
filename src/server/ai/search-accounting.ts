import "server-only";
import {z} from "zod";
import type {JsonObject} from "../../domain/common";
import {decimalRatio,tokenCostMicroUsdCeil,usdToMicroUsdCeil} from "../budget/money";
import {SEARCH_PRICE_USD} from "./constants";
import {jsonDigest} from "./json";
import {NativeUsageSchema,normalizeNativeUsage} from "./native-usage";

/** Authenticated response accounting, independently checked against the reserved native rates and tool envelope. */
export function verifyNativeSearchAccounting(raw:unknown,rateCard:unknown,expected:{reportedCostUsd:string|null;finishReason:string;failure:unknown;annotationCount:number}):{costMicroUsd:string;evidence:JsonObject}|null{
  const parsed=NativeUsageSchema.safeParse(raw);
  const rate=z.object({contextTokens:z.number().int().positive(),pricing:z.object({prompt:z.string(),completion:z.string(),input_cache_read:z.string().optional()}),
    search:z.object({engine:z.literal("parallel"),mode:z.literal("advanced"),max_uses:z.literal(1),maxToolCalls:z.literal(1),inferencePasses:z.literal(2)})}).safeParse(rateCard);
  if(!parsed.success||!rate.success)return null;
  const data=parsed.data,tools=data.server_tool_use_details;
  let usage;try{usage=normalizeNativeUsage(data);}catch{return null;}
  // Output validity is a separate concern: a truncated/refused answer can still have a final charge.
  if(expected.annotationCount<0||expected.annotationCount>5||
    usage.searchRequests!==1||tools?.tool_calls_requested!==1||tools.tool_calls_executed!==1||usage.costUsd===null||data.cost_details?.upstream_inference_cost==null||expected.reportedCostUsd===null)return null;
  const cached=usage.cachedPromptTokens??0;
  if(usage.totalTokens!==usage.promptTokens+usage.completionTokens||usage.promptTokens>rate.data.contextTokens*2||cached>usage.promptTokens||(cached>0&&!rate.data.pricing.input_cache_read))return null;
  try{
    const actual=usdToMicroUsdCeil(usage.costUsd),upstream=decimalRatio(data.cost_details.upstream_inference_cost),total=decimalRatio(usage.costUsd),fee=decimalRatio(SEARCH_PRICE_USD),reported=decimalRatio(expected.reportedCostUsd);
    if(total.numerator*reported.denominator!==reported.numerator*total.denominator)return null;
    const billed=total.numerator*upstream.denominator*fee.denominator;
    const components=upstream.numerator*total.denominator*fee.denominator+fee.numerator*total.denominator*upstream.denominator;
    const residual=billed>components?billed-components:components-billed;
    // Providers may serialize the sum after binary64 addition (e.g. ...7999999999).
    // Permit at most two relative binary64 rounding units, using exact integers.
    // This is far below a microUSD; the original billed decimal still determines
    // settlement, and the independent token ceiling below remains mandatory.
    const includesFee=residual*(2n**51n)<=components;
    const expectedCeiling=tokenCostMicroUsdCeil(usage.promptTokens-cached,rate.data.pricing.prompt)+tokenCostMicroUsdCeil(cached,rate.data.pricing.input_cache_read??rate.data.pricing.prompt)+
      tokenCostMicroUsdCeil(usage.completionTokens,rate.data.pricing.completion)+usdToMicroUsdCeil(SEARCH_PRICE_USD);
    if(!includesFee||actual>expectedCeiling||expectedCeiling-actual>3n)return null;
    return{costMicroUsd:actual.toString(),evidence:{accountingAuthority:"authenticated_completion_native_usage",totalCostUsd:usage.costUsd,
      upstreamInferenceCostUsd:data.cost_details.upstream_inference_cost,searchFeeUsd:SEARCH_PRICE_USD,searchFeeVerified:true,
      searchEngineRequested:rate.data.search.engine,searchRequests:1,toolCallsExecuted:1,nativeUsageDigest:jsonDigest(data),
      feeComparison:residual===0n?"exact":"binary64-relative-2epsilon-v1"}};
  }catch{return null;}
}
