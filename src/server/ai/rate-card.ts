import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../domain/common";
import { decimalAtMost, decimalRatio } from "../budget/money";
import { MODEL_ID, MODEL_POLICY_VERSION, OPENROUTER_BASE_URL, PROVIDER_PRICE_CAP, PROVIDER_TAG, SEARCH_POLICY, SEARCH_PRICE_USD } from "./constants";
import { ProviderFailure } from "./failure";
import { boundedResponseText } from "./http";
import { jsonDigest } from "./json";

export interface ApprovedRateCard { snapshot: JsonObject; digest: string; contextTokens: number; maxOutputTokens: number; observedAt: number }
const endpointSchema = z.object({
  name: z.string(), model_id: z.literal(MODEL_ID), provider_name: z.literal("DigitalOcean"), tag: z.literal(PROVIDER_TAG),
  context_length: z.number().int().positive().max(2_000_000), max_completion_tokens: z.number().int().positive().max(2_000_000),
  supported_parameters: z.array(z.string()), pricing: z.record(z.string(), z.union([z.string(), z.number()])), status: z.literal(0),
});

export function approveEndpoint(payload: unknown, observedAt = Date.now()): ApprovedRateCard {
  const envelope = z.object({ data: z.object({ endpoints: z.array(z.unknown()) }) }).safeParse(payload);
  if (!envelope.success) throw new ProviderFailure("unavailable");
  const selected = envelope.data.data.endpoints.filter((item) => item && typeof item === "object" && "tag" in item && item.tag === PROVIDER_TAG);
  if (selected.length !== 1) throw new ProviderFailure("unavailable");
  const result = endpointSchema.safeParse(selected[0]);
  if (!result.success) throw new ProviderFailure("unavailable");
  const endpoint = result.data;
  for (const key of ["max_tokens", "tools", "tool_choice"]) {
    if (!endpoint.supported_parameters.includes(key)) throw new ProviderFailure("unavailable");
  }
  const pricing: Record<string, string> = {};
  try {
    for (const [key, raw] of Object.entries(endpoint.pricing)) {
      // Rates must be decimal strings; allow numeric zero only for non-billable metadata.
      if (typeof raw !== "string" && raw !== 0) throw new Error();
      const value = String(raw);
      const ratio = decimalRatio(value);
      if (!["prompt", "completion", "input_cache_read"].includes(key) && ratio.numerator !== 0n) throw new Error();
      pricing[key] = value;
    }
    if (!pricing.prompt || !pricing.completion || !decimalAtMost(pricing.prompt, PROVIDER_PRICE_CAP.prompt) ||
      !decimalAtMost(pricing.completion, PROVIDER_PRICE_CAP.completion) ||
      (pricing.input_cache_read && !decimalAtMost(pricing.input_cache_read, pricing.prompt))) throw new Error();
  } catch { throw new ProviderFailure("unavailable"); }
  const snapshot: JsonObject = {
    model: MODEL_ID, provider: PROVIDER_TAG, endpointName: endpoint.name, policyVersion: MODEL_POLICY_VERSION,
    contextTokens: endpoint.context_length, maxOutputTokens: endpoint.max_completion_tokens,
    pricing, selectedCaps: { ...PROVIDER_PRICE_CAP }, search: { ...SEARCH_POLICY, priceUsd: SEARCH_PRICE_USD, maxToolCalls: 1, inferencePasses: 2 },
  };
  return { snapshot, digest: jsonDigest(snapshot), contextTokens: endpoint.context_length,
    maxOutputTokens: endpoint.max_completion_tokens, observedAt };
}

export class OpenRouterRateCards {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async current(signal: AbortSignal): Promise<ApprovedRateCard> {
    try {
      const response = await this.fetcher(`${OPENROUTER_BASE_URL}/models/${MODEL_ID}/endpoints`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: "error", cache: "no-store" });
      if (!response.ok) throw new ProviderFailure("unavailable");
      return approveEndpoint(JSON.parse(await boundedResponseText(response)) as unknown);
    } catch { throw new ProviderFailure(signal.aborted ? "cancelled" : "unavailable"); }
  }
}
