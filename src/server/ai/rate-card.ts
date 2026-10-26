import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../domain/common";
import { decimalAtMost, decimalRatio } from "../budget/money";
import { OPENROUTER_BASE_URL, SEARCH_POLICY, SEARCH_PRICE_USD } from "./constants";
import {modelPolicy,type ModelPolicyId} from "./model-policy";
import { ProviderFailure } from "./failure";
import { boundedResponseText } from "./http";
import { jsonDigest } from "./json";

export interface ApprovedRateCard { snapshot: JsonObject; digest: string; contextTokens: number; maxOutputTokens: number; observedAt: number }
const endpointSchema = z.object({
  name: z.string(), model_id: z.string(), provider_name: z.string(), tag: z.string(),
  context_length: z.number().int().positive().max(2_000_000), max_completion_tokens: z.number().int().positive().max(2_000_000),
  supported_parameters: z.array(z.string()), pricing: z.record(z.string(), z.union([z.string(), z.number()])), status: z.literal(0),
});

export function approveEndpoint(payload: unknown, observedAt = Date.now(), policyId?:ModelPolicyId): ApprovedRateCard {
  const policy=modelPolicy(policyId);
  const envelope = z.object({ data: z.object({ endpoints: z.array(z.unknown()) }) }).safeParse(payload);
  if (!envelope.success) throw new ProviderFailure("unavailable");
  const selected = envelope.data.data.endpoints.filter((item) => item && typeof item === "object" && "tag" in item && item.tag === policy.provider);
  if (selected.length !== 1) throw new ProviderFailure("unavailable");
  const result = endpointSchema.safeParse(selected[0]);
  if (!result.success) throw new ProviderFailure("unavailable");
  const endpoint = result.data;
  if(endpoint.model_id!==policy.model||endpoint.provider_name!==policy.providerName||endpoint.tag!==policy.provider)throw new ProviderFailure("unavailable");
  for (const key of (policy.provider==="google-ai-studio"?["max_tokens","response_format","reasoning","tools","tool_choice"]:["max_tokens", "tools", "tool_choice"])) {
    if (!endpoint.supported_parameters.includes(key)) throw new ProviderFailure("unavailable");
  }
  const pricing: Record<string, string> = {};
  try {
    for (const [key, raw] of Object.entries(endpoint.pricing)) {
      // Rates must be decimal strings; allow numeric zero only for non-billable metadata.
      if (typeof raw !== "string" && raw !== 0 && !(policy.provider==="google-ai-studio"&&key==="discount"&&raw===0.5)) throw new Error();
      const value = String(raw);
      const ratio = decimalRatio(value);
      if (!["prompt", "completion", "input_cache_read"].includes(key) && ratio.numerator !== 0n) {
        if(policy.provider!=="google-ai-studio"||!["internal_reasoning","image","audio","image_output","input_audio","output_audio","input_audio_cache","input_cache_write","web_search","discount"].includes(key))throw new Error();
        if(key==="internal_reasoning"&&!decimalAtMost(value,policy.priceCaps.completion))throw new Error();
      }
      pricing[key] = value;
    }
    if (!pricing.prompt || !pricing.completion || !decimalAtMost(pricing.prompt, policy.priceCaps.prompt) ||
      !decimalAtMost(pricing.completion, policy.priceCaps.completion) ||
      (pricing.input_cache_read && !decimalAtMost(pricing.input_cache_read, pricing.prompt))) throw new Error();
  } catch { throw new ProviderFailure("unavailable"); }
  const snapshot: JsonObject = {
    model: policy.model, provider: policy.provider, endpointName: endpoint.name, policyVersion: policy.id,
    contextTokens: endpoint.context_length, maxOutputTokens: endpoint.max_completion_tokens,
    pricing, selectedCaps: { ...policy.priceCaps }, search: { ...SEARCH_POLICY, priceUsd: SEARCH_PRICE_USD, maxToolCalls: 1, inferencePasses: 2 },
  };
  return { snapshot, digest: jsonDigest(snapshot), contextTokens: endpoint.context_length,
    maxOutputTokens: endpoint.max_completion_tokens, observedAt };
}

export class OpenRouterRateCards {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async current(signal: AbortSignal, policyId?:ModelPolicyId): Promise<ApprovedRateCard> {
    try {
      const response = await this.fetcher(`${OPENROUTER_BASE_URL}/models/${modelPolicy(policyId).model}/endpoints`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "error", cache: "no-store" });
      if (!response.ok) throw new ProviderFailure("unavailable");
      return approveEndpoint(JSON.parse(await boundedResponseText(response)) as unknown,Date.now(),policyId);
    } catch { throw new ProviderFailure(signal.aborted ? "cancelled" : "unavailable"); }
  }
}
