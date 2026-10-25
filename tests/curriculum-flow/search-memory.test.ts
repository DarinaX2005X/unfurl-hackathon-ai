import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { AgentDecisionSchema, LegacyAgentDecisionSchema } from "../../src/server/agent-tools/contracts";
import { jsonDigest } from "../../src/server/ai/json";
import { attachSearchMemory, compactSearchMemory, type CompactSearch } from "../../src/server/agent-turns/search-memory";
import { ContextSnapshotSchema, readSavedSearch } from "../../src/server/agent-turns/repository";
import { PostgresResearchRepository } from "../../src/server/research/repository";
import { stableExecutionId } from "../../src/server/runs/identity";
import type { DbTransaction } from "../../src/server/db";
import type { JsonValue } from "../../src/domain/common";
import type { SearchResult } from "../../src/server/research/ports";
import { ids, now } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function search(index: number, query: string, urls: string[]): CompactSearch {
  return { id: stableExecutionId(ids.request, `search:${index}`), requestedQuery: query, executedQuery: null,
    hits: urls.map((url, hit) => ({ id: stableExecutionId(ids.request, `hit:${index}:${hit}`), url, title: `${query} — result ${hit}` })) };
}
function actualSequence() {
  return [
    search(0, "Mathematics for Machine Learning Deisenroth Faisal Ong", ["https://mml-book.github.io/book/mml-book.pdf", "https://www.cambridge.org/highereducation/books/mathematics-for-machine-learning/5EE57FD1CFB23E6EB11E130309C7EF98", "https://www.deisenroth.cc/publication/deisenroth-2020", "https://mml-book.github.io/", "https://mml-book.com/"]),
    search(1, "An Introduction to Statistical Learning James Witten Hastie Tibshirani 2021", ["https://link.springer.com/book/10.1007/978-1-0716-1418-1", "https://www.statlearning.com/", "https://trevorhastie.github.io/ISLR", "https://link.springer.com/chapter/10.1007/978-1-0716-1418-1_1", "https://anthology-of-data.science/books/islp.html"]),
    search(2, "AI Engineering Chip Huyen O'Reilly designing machine learning systems", ["https://huyenchip.com/", "https://huyenchip.com/books/", "https://www.oreilly.com/library/view/designing-machine-learning/9781098107956/", "https://linkedin.com/in/chiphuyen", "https://snorkel.ai/author/chip-huyen"]),
  ];
}
function base(data: JsonValue, tool = "read_source") {
  return { kind: "context", index: 3, now, currentMessage: "Design the requested full course.", recentMessages: [] as Array<{ role: "user" | "assistant"; text: string }>,
    artifacts: [], sources: [{ sourceId: ids.source, title: "Read source", url: "https://example.test/source" }],
    recentTools: [{ tool, ok: true, summary: "Stored observation", data }], languageIntent: null };
}

it("pins the already-paid planner schema and leaves old captures byte-equivalent", () => {
  expect(jsonDigest(z.toJSONSchema(LegacyAgentDecisionSchema), 65536)).toBe("cdd6a9c8a9b2d2199d3a6d9fd4e1be7920ae3cb49c9e08acea5a2336e6c92f2d");
  const old = base(null);
  expect(JSON.stringify(ContextSnapshotSchema.parse(old))).toBe(JSON.stringify(old));
  expect(ContextSnapshotSchema.parse(old)).not.toHaveProperty("searchMemory");
  const retrieval = { tool: "read_source", input: { kind: "search_result", searchId: ids.request, offset: 0, limit: 5 } };
  expect(AgentDecisionSchema.safeParse(retrieval).success).toBe(true);
  expect(LegacyAgentDecisionSchema.safeParse(retrieval).success).toBe(false);
});

it("retains all candidates from the observed three-search sequence and the latest full source blocks", () => {
  const searches = actualSequence();
  const blocks = { kind: "blocks", sourceId: ids.source, blocks: [{ id: "b1", text: "The complete recently read source text." }], overview: false };
  const snapshot = attachSearchMemory(base(blocks), searches);
  expect(snapshot.searchMemory.overflow).toBe(false);
  expect(snapshot.searchMemory.searches.map((entry) => entry.requestedQuery)).toEqual(searches.map((entry) => entry.requestedQuery));
  expect(snapshot.searchMemory.searches.flatMap((entry) => entry.candidates)).toEqual(searches.flatMap((entry) => entry.hits));
  expect(snapshot.recentTools[0]!.data).toEqual(blocks);
  expect(snapshot.sources).toEqual(base(null).sources);
  expect(snapshot.searchMemory.snippetsAreReadSources).toBe(false);
  expect(bytes(snapshot)).toBeLessThan(220 * 1024);
});

it("keeps every search/hit identity with explicit detail retrieval when Unicode metadata overflows", () => {
  const searches = Array.from({ length: 64 }, (_, index) => ({ ...search(index, "学".repeat(2000), Array.from({ length: 5 }, (_, hit) => `https://example.test/${index}/${hit}/${"x".repeat(4000)}`)),
    hits: Array.from({ length: 5 }, (_, hit) => ({ id: stableExecutionId(ids.request, `hit:${index}:${hit}`), title: "学".repeat(1000), url: `https://example.test/${index}/${hit}/${"x".repeat(4000)}` })) }));
  const memory = compactSearchMemory(searches);
  expect(memory.overflow).toBe(true);
  expect(bytes(memory)).toBeLessThanOrEqual(64 * 1024);
  expect(memory.searches.map((entry) => entry.searchId)).toEqual(searches.map((entry) => entry.id));
  expect(memory.searches.flatMap((entry) => entry.candidates.map((hit) => hit.id))).toEqual(searches.flatMap((entry) => entry.hits.map((hit) => hit.id)));
  expect(memory.searches.some((entry) => entry.candidates.some((hit) => hit.url === null))).toBe(true);
  const data = { sourceId: ids.source, blocks: Array.from({ length: 4 }, (_, index) => ({ id: `b${index}`, text: "学".repeat(20000) })), overview: false };
  const snapshot = attachSearchMemory(base(data), searches);
  expect(bytes(snapshot)).toBeLessThanOrEqual(220 * 1024);
  expect(snapshot.recentTools[0]!.data).toMatchObject({ sourceId: ids.source, blockIds: ["b0", "b1", "b2", "b3"], payloadOmitted: true, retrieval: "read_source.blocks" });
  expect(snapshot.sources).toEqual(base(null).sources);
});

it("retrieves the complete original search only through this job's saved receipt", async () => {
  const compact = actualSequence()[0]!;
  const original: SearchResult = { ...compact, operationId: ids.request, provider: "openrouter:parallel", providerRequestId: "fixture",
    contentLanguage: "en", retrievedAt: now, requestDigest: "a".repeat(64), limitations: ["snippets_are_not_read_sources"],
    hits: compact.hits.map((hit) => ({ ...hit, snippet: "An unread search snippet.", publishedAt: null })) };
  const getSearch = vi.spyOn(PostgresResearchRepository.prototype, "getSearch").mockResolvedValue(original);
  const query = vi.fn(async (_sql: string, values: unknown[]) => ({ rows: values[0] === ids.approval && values[1] === compact.id ? [{ id: ids.task }] : [] }));
  const tx = { query } as unknown as DbTransaction;
  expect(await readSavedSearch(tx, ids.approval, compact.id)).toEqual(original);
  expect(query.mock.calls[0]![0]).toContain("current_job.id=$1");
  expect(query.mock.calls[0]![1]).toEqual([ids.approval, compact.id]);
  await expect(readSavedSearch(tx, ids.missing, compact.id)).rejects.toMatchObject({ status: 404 });
  expect(getSearch).toHaveBeenCalledOnce();
});

it("continues beyond 64 searches and exposes a paged history when the index itself exceeds its byte budget", () => {
  const searches = Array.from({ length: 300 }, (_, index) => search(index, `Research branch ${index}`, Array.from({ length: 5 }, (_, hit) => `https://example.test/${index}/${hit}`)));
  const memory = compactSearchMemory(searches);
  expect(Buffer.byteLength(JSON.stringify(memory))).toBeLessThanOrEqual(64 * 1024);
  expect(memory.history).toMatchObject({ totalSearches: 300, omittedSearches: 300 - memory.searches.length,
    category: "searches", offset: 0, retrieval: "read_source.history" });
  expect(memory.history!.omittedSearches).toBeGreaterThan(0);
  expect(memory.searches.at(-1)!.searchId).toBe(searches.at(-1)!.id);
});
