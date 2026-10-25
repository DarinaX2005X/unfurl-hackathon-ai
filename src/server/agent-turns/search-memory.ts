import "server-only";
import { z } from "zod";
import { IdSchema, type JsonValue } from "../../domain/common";
import { ProviderFailure } from "../ai/failure";

export const CompactSearchSchema = z.object({ id: IdSchema, requestedQuery: z.string().min(1).max(2000),
  executedQuery: z.string().min(1).max(2000).nullable(),
  hits: z.array(z.object({ id: IdSchema, title: z.string().min(1).max(1000), url: z.string().min(1).max(4096) }).strict()).max(5),
}).strict();
export type CompactSearch = z.infer<typeof CompactSearchSchema>;
export const SearchMemorySchema = z.object({
  searches: z.array(z.object({ searchId: IdSchema, queryPreview: z.string(), requestedQuery: z.string().nullable(),
    candidates: z.array(z.object({ id: IdSchema, title: z.string().nullable(), url: z.string().nullable() }).strict()),
  }).strict()).max(64),
  overflow: z.boolean(), retrieval: z.literal("read_source.search_result"), snippetsAreReadSources: z.literal(false),
}).strict();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const preview = (text: string) => Array.from(text).slice(0, 80).join("");
function manifest(searches: readonly CompactSearch[]): z.infer<typeof SearchMemorySchema> {
  if (searches.length > 64 || new Set(searches.map((search) => search.id)).size !== searches.length) throw new ProviderFailure("invalid_output");
  return { searches: searches.map((search) => ({ searchId: search.id, queryPreview: preview(search.requestedQuery), requestedQuery: null,
    candidates: search.hits.map((hit) => ({ id: hit.id, title: null, url: null })) })),
  overflow: searches.length > 0, retrieval: "read_source.search_result", snippetsAreReadSources: false };
}
export function compactSearchMemory(searches: readonly CompactSearch[], maximumBytes = 64 * 1024) {
  const result = manifest(searches);
  if (bytes(result) > maximumBytes) throw new ProviderFailure("invalid_output");
  // Recent discoveries get detail first. Every search/candidate identity remains, including overflow.
  for (let index = searches.length - 1; index >= 0; index--) {
    const source = searches[index]!, entry = result.searches[index]!;
    entry.requestedQuery = source.requestedQuery;
    if (bytes(result) > maximumBytes) entry.requestedQuery = null;
    for (const [hitIndex, hit] of source.hits.entries()) {
      const candidate = entry.candidates[hitIndex]!;
      candidate.title = hit.title; candidate.url = hit.url;
      if (bytes(result) > maximumBytes) { candidate.title = null; candidate.url = null; }
    }
  }
  result.overflow = result.searches.some((search) => search.requestedQuery === null || search.candidates.some((hit) => hit.url === null));
  return SearchMemorySchema.parse(result);
}

interface ToolMemory { tool: string; ok: boolean; summary: string; data: JsonValue }
interface ContextEvidence { recentTools: ToolMemory[]; recentMessages: Array<{ role: "user" | "assistant"; text: string }> }
function storedReference(data: JsonValue): JsonValue {
  if (!data || Array.isArray(data) || typeof data !== "object") return { payloadOmitted: true, reason: "context_size" };
  if (typeof data.sourceId === "string") {
    const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data.blockIndex) ? data.blockIndex : [];
    const blockIds = blocks.flatMap((block) => block && !Array.isArray(block) && typeof block === "object" && typeof block.id === "string" ? [block.id] : []);
    return { sourceId: data.sourceId, blockIds, payloadOmitted: true, reason: "context_size",
      retrieval: "read_source.blocks", instruction: "Read a smaller selection of these saved block IDs to retrieve their complete text." };
  }
  if (typeof data.searchId === "string") return { searchId: data.searchId, payloadOmitted: true, reason: "context_size", retrieval: "read_source.search_result", snippetsAreReadSources: false };
  return { payloadOmitted: true, reason: "context_size", retrieval: "read_artifact", courseId: typeof data.courseId === "string" ? data.courseId : null };
}

/** Retains exact latest block text when it fits; any unavoidable omission is explicit and recoverable. */
export function attachSearchMemory<T extends ContextEvidence>(base: T, searches: readonly CompactSearch[], maximumBytes = 220 * 1024) {
  const copy = structuredClone(base);
  const latest = copy.recentTools.at(-1);
  if (latest?.tool === "search" && latest.ok && latest.data && !Array.isArray(latest.data) && typeof latest.data === "object") {
    latest.data = { searchId: latest.data.id ?? null, candidatesIn: "searchMemory", snippetsAreReadSources: false };
  }
  const minimum = manifest(searches);
  let omittedRecentMessages = 0;
  const withMemory = (searchMemory: z.infer<typeof SearchMemorySchema>) => ({ ...copy, searchMemory,
    ...(omittedRecentMessages ? { omittedRecentMessages } : {}) });
  while (bytes(withMemory(minimum)) > maximumBytes && copy.recentMessages.length > 0) {
    copy.recentMessages.shift(); omittedRecentMessages++;
  }
  if (bytes(withMemory(minimum)) > maximumBytes && latest?.data !== undefined) latest.data = storedReference(latest.data);
  const available = maximumBytes - bytes(withMemory(minimum)) + bytes(minimum);
  const result = withMemory(compactSearchMemory(searches, Math.min(64 * 1024, available)));
  if (bytes(result) > maximumBytes) throw new ProviderFailure("invalid_output");
  return result;
}
