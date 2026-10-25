import "server-only";
import {z} from "zod";
import type {NativeUsage} from "./ports";
import {ProviderFailure} from "./failure";

const count=z.number().int().nonnegative().max(10_000_000);
export const NATIVE_USAGE_VERSION="openrouter-native-usage-v2";
export const NativeUsageSchema=z.object({
  prompt_tokens:count,completion_tokens:count,total_tokens:count,cost:z.string().nullable().optional(),
  completion_tokens_details:z.object({reasoning_tokens:count.optional()}).optional(),
  prompt_tokens_details:z.object({cached_tokens:count.optional()}).optional(),
  server_tool_use:z.object({web_search_requests:count.optional()}).optional(),
  server_tool_use_details:z.object({web_search_requests:count.optional(),tool_calls_requested:count.optional(),tool_calls_executed:count.optional()}).optional(),
  cost_details:z.object({upstream_inference_cost:z.string().nullable().optional()}).optional(),
});
export function normalizeNativeUsage(raw:unknown):NativeUsage{
  const data=NativeUsageSchema.parse(raw),legacy=data.server_tool_use?.web_search_requests,current=data.server_tool_use_details?.web_search_requests;
  if(legacy!==undefined&&current!==undefined&&legacy!==current)throw new ProviderFailure("invalid_output");
  return{promptTokens:data.prompt_tokens,completionTokens:data.completion_tokens,totalTokens:data.total_tokens,
    reasoningTokens:data.completion_tokens_details?.reasoning_tokens??null,cachedPromptTokens:data.prompt_tokens_details?.cached_tokens??null,
    searchRequests:current??legacy??0,costUsd:data.cost??null};
}
