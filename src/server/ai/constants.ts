import "server-only";

/** Product policy: changing either identity requires an explicit reviewed decision. */
export const MODEL_ID = "moonshotai/kimi-k2.6" as const;
export const PROVIDER_TAG = "digitalocean" as const;
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const PROVIDER_PRICE_CAP = Object.freeze({ prompt: "0.00000060", completion: "0.00000260" });
export const SEARCH_POLICY = Object.freeze({
  engine: "parallel", mode: "advanced", max_uses: 1, max_results: 5,
  max_total_results: 5, max_characters: 2000,
} as const);
export const SEARCH_PRICE_USD = "0.005";
export const MODEL_POLICY_VERSION = "kimi-digitalocean-v1";
export const MAX_OUTPUT_TOKENS = 8192;
export const LONGFORM_CURRICULUM_OUTPUT_TOKENS = 16384;
export const LONGFORM_CURRICULUM_DURATION_MS = 260_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_DURATION_MS = 90_000;

