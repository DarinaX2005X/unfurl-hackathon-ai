import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../domain/common";
import { ProviderFailure } from "./failure";
import { jsonDigest } from "./json";
import { modelPolicy, ModelPolicySchema } from "./model-policy";
import { KimiContextBoundSchema } from "./kimi-context";

export const PROVIDER_MAX_OUTPUT_POLICY = "provider-max-output-v1" as const;
export const OUTPUT_POLICY_STEP_KEY = "execution/provider-output-policy.v1";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const tokens = z.number().int().positive().safe();

/** This reference is issued by the durable executor from an immutable job receipt. */
export const CapturedOutputPolicySchema = z.object({
  version: z.literal(PROVIDER_MAX_OUTPUT_POLICY), jobId: z.uuid(), receiptId: z.uuid(), receiptDigest: digest,
}).strict();
export type CapturedOutputPolicy = z.infer<typeof CapturedOutputPolicySchema>;

/** Frozen with endpoint metadata in the operation's immutable rate-card JSON. */
export const ProviderPromptAllowanceSchema = z.object({
  version: z.literal("application-prompt-allowance-v1"), applicationPromptDigest: digest,
  assessment: z.discriminatedUnion("kind", [KimiContextBoundSchema, z.object({
    kind: z.literal("unchecked-prompt-boundary"), reason: z.literal("no-verified-local-tokenizer"),
    providerFraming: z.literal("unverified"), serverToolContext: z.enum(["not-requested", "unverified"]),
  }).strict()]),
}).strict();
export type ProviderPromptAllowance = z.infer<typeof ProviderPromptAllowanceSchema>;

export const ProviderOutputResolutionSchema = z.object({
  version: z.literal(PROVIDER_MAX_OUTPUT_POLICY), capture: CapturedOutputPolicySchema,
  rateCardDigest: digest, contextTokens: tokens, endpointMaxOutputTokens: tokens, maxOutputTokens: tokens,
  promptAllowance: ProviderPromptAllowanceSchema,
}).strict();
export type ProviderOutputResolution = z.infer<typeof ProviderOutputResolutionSchema>;
export const ProviderOutputEvidenceSchema = ProviderOutputResolutionSchema.extend({ requestDigest: digest }).strict();

/** A stored operation's rate card is the authority on replay, never current metadata. */
export function resolveProviderOutput(capture: CapturedOutputPolicy, rateCard: JsonObject, rateCardDigest: string): ProviderOutputResolution {
  CapturedOutputPolicySchema.parse(capture);
  const saved = z.object({ policyVersion: ModelPolicySchema, model: z.string(), provider: z.string(),
    contextTokens: tokens, maxOutputTokens: tokens, promptAllowance: ProviderPromptAllowanceSchema }).passthrough().parse(rateCard);
  const policy = modelPolicy(saved.policyVersion);
  if (saved.model !== policy.model || saved.provider !== policy.provider ||
      jsonDigest(rateCard, 64 * 1024) !== digest.parse(rateCardDigest) || saved.maxOutputTokens > saved.contextTokens) {
    throw new ProviderFailure("unavailable");
  }
  const assessment = saved.promptAllowance.assessment;
  if ((policy.id === "kimi-digitalocean-v1") !== (assessment.kind === "model-template-utf8-upper-bound")) {
    throw new ProviderFailure("unavailable");
  }
  const maxOutputTokens = assessment.kind === "model-template-utf8-upper-bound"
    ? Math.min(saved.maxOutputTokens, saved.contextTokens - assessment.promptTokensUpperBound)
    : saved.maxOutputTokens;
  // Preserve the complete input. A request with no proved local capacity must
  // be handled by a separate continuation, never truncated or dispatched here.
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new ProviderFailure("invalid_output");
  return { version: PROVIDER_MAX_OUTPUT_POLICY, capture, rateCardDigest,
    contextTokens: saved.contextTokens, endpointMaxOutputTokens: saved.maxOutputTokens, maxOutputTokens,
    promptAllowance: saved.promptAllowance };
}

/** Paid-response consumers verify the same frozen allowance that produced the wire digest. */
export function verifyProviderOutputEvidence(input: {
  capture: CapturedOutputPolicy | undefined; rateCard: JsonObject; rateCardDigest: string;
  requestDigest: string; result: unknown;
}): void {
  const result = input.result !== null && typeof input.result === "object" && !Array.isArray(input.result)
    ? input.result as Record<string, unknown> : {};
  if (!input.capture) {
    if (result.outputResolution !== undefined) throw new ProviderFailure("invalid_output");
    return;
  }
  const expected = { ...resolveProviderOutput(input.capture, input.rateCard, input.rateCardDigest), requestDigest: input.requestDigest };
  const actual = ProviderOutputEvidenceSchema.safeParse(result.outputResolution);
  if (!actual.success || jsonDigest(actual.data) !== jsonDigest(expected)) throw new ProviderFailure("invalid_output");
}
