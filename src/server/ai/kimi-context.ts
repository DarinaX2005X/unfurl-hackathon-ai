import "server-only";
import { z } from "zod";
import { ProviderFailure } from "./failure";
import { digestBytes } from "./json";

export const KIMI_TEMPLATE_REVISION = "7eb5002f6aadc958aed6a9177b7ed26bb94011bb" as const;
export const KIMI_CONTEXT_BOUND_VERSION = "kimi-k2.6-application-template-utf8-v1" as const;
export type ApplicationPromptMessages = readonly [
  { role: "system"; content: string }, { role: "user"; content: string },
];

export const KimiContextBoundSchema = z.object({
  kind: z.literal("model-template-utf8-upper-bound"),
  version: z.literal(KIMI_CONTEXT_BOUND_VERSION),
  modelRevision: z.literal(KIMI_TEMPLATE_REVISION),
  countedScope: z.literal("application-messages"),
  promptTokensUpperBound: z.number().int().positive().safe(),
  renderedPromptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerFraming: z.literal("unverified"),
  serverToolContext: z.enum(["not-requested", "unverified"]),
}).strict();
export type KimiContextBound = z.infer<typeof KimiContextBoundSchema>;

/** The complete pinned template for our two text messages, with its default
 * thinking=true/add_generation_prompt=true. No model/provider tokenizer claim:
 * DigitalOcean's additional framing and OpenRouter server-tool messages are
 * not visible to this application and are explicitly outside this bound.
 *
 * Pinned sources (no downloads or tokenizer installation at runtime):
 * https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/chat_template.jinja
 * https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/tokenization_kimi.py
 * https://huggingface.co/moonshotai/Kimi-K2.6/blob/7eb5002f6aadc958aed6a9177b7ed26bb94011bb/tiktoken.model
 *
 * The tokenizer uses byte-level BPE without expanding normalization. The
 * pinned vocabulary contains every byte and no empty byte token (163584
 * mergeable entries, lengths 1..256). Each ordinary token consumes >=1 UTF-8
 * byte; recognized nonempty special-token strings consume one token. Thus
 * byteLength of this FULL rendered template is a conservative upper bound,
 * including role/turn markers and the generation prefix, with no fixed reserve.
 */
export function renderKimiApplicationPrompt(messages: ApplicationPromptMessages): string {
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user" ||
      messages.some(message => typeof message.content !== "string")) throw new ProviderFailure("invalid_output");
  return `<|im_system|>system<|im_middle|>${messages[0].content}<|im_end|>` +
    `<|im_user|>user<|im_middle|>${messages[1].content}<|im_end|>` +
    "<|im_assistant|>assistant<|im_middle|><think>";
}

export function boundKimiApplicationPrompt(messages: ApplicationPromptMessages, serverTools: boolean): KimiContextBound {
  const rendered = renderKimiApplicationPrompt(messages);
  return KimiContextBoundSchema.parse({
    kind: "model-template-utf8-upper-bound", version: KIMI_CONTEXT_BOUND_VERSION,
    modelRevision: KIMI_TEMPLATE_REVISION, countedScope: "application-messages",
    promptTokensUpperBound: Buffer.byteLength(rendered, "utf8"), renderedPromptDigest: digestBytes(rendered),
    providerFraming: "unverified", serverToolContext: serverTools ? "unverified" : "not-requested",
  });
}
