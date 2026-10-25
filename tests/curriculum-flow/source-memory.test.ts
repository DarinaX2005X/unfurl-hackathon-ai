import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { compactSourceMemory, type ReadMemoryReceipt } from "../../src/server/agent-turns/source-memory";
import { ContextSnapshotSchema, readSavedSourceResult, readSourceHistory } from "../../src/server/agent-turns/repository";
import { agentDecisionSchemaForCapture, AgentDecisionV3Schema, AgentDecisionSchema } from "../../src/server/agent-tools/contracts";
import { attachSearchMemory } from "../../src/server/agent-turns/search-memory";
import { agentActionDetails } from "../../src/server/agent-tools/action-details";
import { ActionDetailsSchema } from "../../src/domain/generation";
import { stableExecutionId } from "../../src/server/runs/identity";
import type { DbTransaction } from "../../src/server/db";
import type { SourceDocument } from "../../src/server/research/ports";
import { ids, now, researchFixture } from "./fixtures";

function receipt(index: number, sourceId: string | null, fullyReadBlockIds: string[] = []): ReadMemoryReceipt {
  return { stepId: stableExecutionId(ids.request, `read:${index}`), sourceId, fullyReadBlockIds, failedUrl: null, failureStatus: null };
}

it("preserves both sources' exact block identities and read coverage after another source is read", async () => {
  const { source } = await researchFixture();
  const islr: SourceDocument = { ...source, blocks: [{ id: "block-1", text: "Regression" }, { id: "block-2", text: "A substantive explanation of held-out evaluation." }] };
  const mml: SourceDocument = { ...source, id: stableExecutionId(ids.source, "mml"), blocks: [{ id: "block-13", text: "Linear Algebra" }, { id: "block-17", text: "Probability and Distribution" }] };
  const failedUrl = "https://www.oreilly.com/library/view/designing-machine-learning/9781098107956/";
  const reads = [receipt(4, mml.id), { ...receipt(5, null), failedUrl, failureStatus: "unavailable" as const }, receipt(6, islr.id), receipt(7, islr.id, ["block-1", "block-2"]),
    { ...receipt(8, null), failedUrl, failureStatus: "unavailable" as const }, receipt(9, mml.id), receipt(10, mml.id, ["block-13"]), receipt(11, islr.id)];
  const memory = compactSourceMemory([islr, mml], reads);
  expect(memory.sources.map((item) => item.fullyReadBlockIds)).toEqual([["block-1", "block-2"], ["block-13"]]);
  expect(memory.sources[0]!.blocks).toEqual([{ id: "block-1", characters: 10, fullyRead: true, preview: "Regression" },
    { id: "block-2", characters: "A substantive explanation of held-out evaluation.".length, fullyRead: true, preview: "A substantive explanation of held-out evaluation." }]);
  expect(memory.sources[1]!.blocks![1]!.fullyRead).toBe(false);
  expect(memory.failedUrlReads).toEqual([{ stepId: reads[4]!.stepId, url: failedUrl, urlPreview: failedUrl, status: "unavailable", attempts: 2 }]);
  expect(memory.previewsAreEvidence).toBe(false);
  const snapshot = attachSearchMemory({ kind: "context", index: 12, now, currentMessage: "Create a researched course.", recentMessages: [], artifacts: [],
    sources: [islr, mml].map((document) => ({ sourceId: document.id, title: document.title, url: document.finalUrl })), sourceMemory: memory,
    recentTools: [{ tool: "read_source", ok: true, summary: "Listed the source blocks.", data: { sourceId: islr.id, blocks: islr.blocks, overview: true } }], languageIntent: null }, []);
  expect(ContextSnapshotSchema.parse(snapshot).sourceMemory).toEqual(memory);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(220 * 1024);
});

it("bounds large source indexes while preserving source/count/read references and explicit retrieval", async () => {
  const { source } = await researchFixture();
  const documents = Array.from({ length: 20 }, (_, index): SourceDocument => ({ ...source, id: stableExecutionId(ids.source, `source:${index}`),
    blocks: Array.from({ length: 100 }, (_, block) => ({ id: `block-${block}-${"x".repeat(50)}`, text: "学".repeat(1000) })) }));
  const reads = documents.map((document, index) => receipt(index, document.id, document.blocks.slice(0, 4).map((block) => block.id)));
  const memory = compactSourceMemory(documents, reads, 24000);
  expect(memory.overflow).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(memory))).toBeLessThanOrEqual(24000);
  expect(memory.sources.map((item) => item.sourceId)).toEqual(documents.map((document) => document.id));
  expect(memory.sources.every((item) => item.fullyReadBlockCount === 4)).toBe(true);
  expect(memory.sources.some((item) => item.blocks === null)).toBe(true);
  expect(memory.blockRetrieval).toBe("read_source.blocks");
  expect(memory.failedReadRetrieval).toBe("read_source.saved_read");
});

it("recovers a failed-read overflow reference only through its current job's receipt", async () => {
  const saved = { tool: "read_source", ok: false, summary: "The source was unavailable.", data: { status: "unavailable", requestedUrl: "https://example.test/source" }, sourceIds: [], artifactIds: [] };
  const query = vi.fn(async (_sql: string, values: unknown[]) => ({ rows: values[0] === ids.approval && values[1] === ids.task ? [{ result_reference: saved }] : [] }));
  const tx = { query } as unknown as DbTransaction;
  expect(await readSavedSourceResult(tx, ids.approval, ids.task)).toEqual(saved);
  await expect(readSavedSourceResult(tx, ids.missing, ids.task)).rejects.toMatchObject({ status: 404 });
  expect(query.mock.calls[0]![0]).toContain("current_job.id=$1");
  expect(query.mock.calls[0]![0]).toContain("WHERE id=$2");
});

it("exposes a paged history instead of failing when even all source headers exceed the context budget", async () => {
  const { source } = await researchFixture();
  const documents = Array.from({ length: 100 }, (_, index) => ({ ...source, id: stableExecutionId(ids.source, `header:${index}`) }));
  const memory = compactSourceMemory(documents, documents.map((document, index) => receipt(index, document.id)), 4000);
  expect(Buffer.byteLength(JSON.stringify(memory))).toBeLessThanOrEqual(4000);
  expect(memory.history).toMatchObject({ totalReadReceipts: 100, omittedSources: 100 - memory.sources.length,
    category: "source_reads", offset: 0, retrieval: "read_source.history" });
  expect(memory.history!.omittedSources).toBeGreaterThan(0);
  const entry = { stepId: ids.task, tool: "read_source", ok: true, searchId: null, sourceId: documents[0]!.id,
    query: null, title: source.title, url: source.finalUrl, status: null, blockCount: source.blocks.length, candidateCount: null, fullyReadBlockIds: [] };
  const query = vi.fn(async (_sql: string, values: unknown[]) => ({ rows: [{ total: values[0] === ids.approval ? 100 : 0, entries: values[0] === ids.approval ? [entry] : [] }] }));
  const tx = { query } as unknown as DbTransaction;
  expect(await readSourceHistory(tx, ids.approval, { category: "source_reads", offset: 0, limit: 1 })).toMatchObject({ entries: [entry], total: 100, nextOffset: 1 });
  expect(await readSourceHistory(tx, ids.missing, { category: "source_reads", offset: 0, limit: 1 })).toMatchObject({ entries: [], total: 0, nextOffset: null });
  expect(query.mock.calls[0]![1]).toEqual([ids.approval, "source_reads", 1, 0]);
});

it("selects the captured protocol and never widens an old schema to accept commentary or recovery tools", () => {
  const decision = { tool: "read_source", commentary: null, input: { kind: "saved_read", stepId: ids.task } };
  expect(AgentDecisionV3Schema.safeParse(decision).success).toBe(true);
  expect(AgentDecisionSchema.safeParse(decision).success).toBe(false);
  expect(agentDecisionSchemaForCapture({}).schemaVersion).toBe(1);
  expect(agentDecisionSchemaForCapture({ searchMemory: {} }).schemaVersion).toBe(2);
  expect(agentDecisionSchemaForCapture({ agentProtocol: "conversational-v3" }).schemaVersion).toBe(3);
  expect(AgentDecisionV3Schema.safeParse({ tool: "search", input: { query: "Primary sources", language: "en", limit: 3 } }).success).toBe(false);
  expect(AgentDecisionV3Schema.safeParse({ tool: "respond", input: { text: "A final answer.", awaitingUser: false } }).success).toBe(true);
});

it("projects public action facts without exposing tool authority or private identifiers", () => {
  const snapshot = ContextSnapshotSchema.parse({ kind: "context", index: 0, now, currentMessage: "Help me learn.", recentMessages: [], artifacts: [],
    sources: [{ sourceId: ids.source, title: "A real source", url: "https://example.test/source" }], recentTools: [], languageIntent: null });
  const details = agentActionDetails({ tool: "read_source", commentary: null, input: { kind: "blocks", sourceId: ids.source, blockIds: ["b1", "b2"] } }, snapshot);
  expect(details).toEqual({ source: { title: "A real source", url: "https://example.test/source" }, sectionCount: 2 });
  expect(ActionDetailsSchema.safeParse({ ...details, sourceId: ids.source, tool: "read_source" }).success).toBe(false);
});
