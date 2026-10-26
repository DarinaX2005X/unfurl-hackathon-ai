import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import { AgentDecisionSchema, AgentDecisionV3Schema, AgentDecisionV4Schema, LegacyAgentDecisionSchema,
  agentDecisionSchemaForCapture, type AgentDecision, type AgentToolAuthority } from "../../src/server/agent-tools/contracts";
import { executeAgentTool, prepareAgentDecision } from "../../src/server/agent-tools/executor";
import { agentActionDetails } from "../../src/server/agent-tools/action-details";
import { buildAgentDecisionRequest } from "../../src/server/agent-turns/handler";
import * as repository from "../../src/server/agent-turns/repository";
import { ContextSnapshotSchema, type ContextSnapshot } from "../../src/server/agent-turns/repository";
import { compactSourceMemory } from "../../src/server/agent-turns/source-memory";
import { currentReaderCapabilities } from "../../src/server/research/reader-capabilities";
import { PDF_EXTRACTOR_VERSION, SourceDocumentSchema, type SourceDocument, type SourceReadInput, type SourceReadResult } from "../../src/server/research/ports";
import { PostgresResearchRepository } from "../../src/server/research/repository";
import { stableExecutionId } from "../../src/server/runs/identity";
import type { ModelPort } from "../../src/server/ai/ports";
import type { DbTransaction } from "../../src/server/db";
import type { RunContext, StepEffectContext } from "../../src/server/runs/ports";
import { ids, legacyReaderCapabilities, now, researchFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
const target = { kind: "agent_turn" as const, runId: ids.request, ownerId: ids.actor, conversationId: ids.conversation,
  branchId: ids.sample, inputMessageId: ids.missing };
const continuation = (sourceId: string): AgentDecision => ({ tool: "read_source", commentary: null, input: { kind: "continue", sourceId } });
const authority = (sourceIds: Iterable<string> = []): AgentToolAuthority => ({ ...target, artifactIds: new Set(), sourceIds: new Set(sourceIds) });
function snapshot(pdf = true): ContextSnapshot {
  return ContextSnapshotSchema.parse({ kind: "context", index: 0, now, currentMessage: "Research every chapter needed for the course.",
    recentMessages: [], artifacts: [], sources: [], recentTools: [], languageIntent: null,
    agentProtocol: pdf ? "conversational-pdf-v4" : "conversational-v3",
    readerCapabilities: pdf ? currentReaderCapabilities() : legacyReaderCapabilities() });
}
async function documents() {
  const { source: text } = await researchFixture();
  const pdf = (page: number): SourceDocument => SourceDocumentSchema.parse({ ...text, id: stableExecutionId(ids.source, `pdf:${page}`),
    requestedUrl: "https://example.edu/book.pdf", finalUrl: "https://example.edu/edition/book.pdf", mediaType: "application/pdf",
    extractorVersion: PDF_EXTRACTOR_VERSION, contentDigest: String(page + 2).repeat(64), extractionState: "truncated",
    blocks: [{ id: `page-${page}-offset-0`, text: text.blocks[0]!.text }],
    pdfPart: { kind: "pdf-text-v1", totalPages: 3, start: { page, offset: 0 }, end: { page, offset: text.blocks[0]!.text.length },
      next: page < 3 ? { kind: "pdf-text-v1", rawDigest: text.rawDigest, extractorVersion: PDF_EXTRACTOR_VERSION,
        totalPages: 3, page: page + 1, offset: 0 } : null } });
  return { text, first: pdf(1), second: pdf(2), last: pdf(3) };
}
function harness() {
  const tx = {} as DbTransaction, saved = new Map<string, unknown>(), publicEvents: unknown[] = [];
  const signal = new AbortController().signal;
  const context = { claim: { jobId: ids.approval, target }, signal,
    read: (work: (tx: DbTransaction, targetValue: typeof target) => Promise<unknown>) => work(tx, target),
    async step(spec: Parameters<RunContext["step"]>[0]) {
      if (saved.has(spec.key)) return spec.resultSchema.parse(saved.get(spec.key));
      const effect = { signal, stepId: ids.task, deadlineAt: Date.now() + 10000 } as StepEffectContext;
      const output = spec.outputSchema.parse(await spec.effect(effect, spec.input));
      const result = spec.resultSchema.parse(await spec.commit(tx, output));
      saved.set(spec.key, result);
      return result;
    },
    emitChat: async (_tx: DbTransaction, event: unknown) => { publicEvents.push(event); },
  } as unknown as RunContext;
  const read = vi.fn(async (input: SourceReadInput): Promise<SourceReadResult> => ({ status: "unavailable", requestedUrl: input.url }));
  async function execute(decision: AgentDecision, capture = snapshot(), index = 0) {
    return executeAgentTool(context, { kind: "decision", index, invocationId: stableExecutionId(ids.task, `invocation:${index}`),
      decision, capturedDraft: null, capturedCourseRevision: null, preparationError: null }, capture,
    { model: {} as ModelPort, researchForStep: () => ({ read, search: async () => { throw new Error("No search is expected"); } }) });
  }
  return { execute, read, publicEvents, context };
}

it("exposes a saved-source-only continuation variant exclusively through the captured v4 schema", () => {
  const decision = continuation(ids.source);
  expect(AgentDecisionV4Schema.parse(decision)).toEqual(decision);
  for (const schema of [LegacyAgentDecisionSchema, AgentDecisionSchema, AgentDecisionV3Schema]) expect(schema.safeParse(decision).success).toBe(false);
  for (const extra of [{ url: "https://other.example/book.pdf" }, { continuation: { page: 2 } }, { rawDigest: "1".repeat(64) }, { readerPolicy: "text-pdf-parts-v2" }]) {
    expect(AgentDecisionV4Schema.safeParse({ ...decision, input: { ...decision.input, ...extra } }).success).toBe(false);
  }
  expect(agentDecisionSchemaForCapture(snapshot()).schema).toBe(AgentDecisionV4Schema);
  expect(ContextSnapshotSchema.safeParse({ ...snapshot(), readerCapabilities: legacyReaderCapabilities() }).success).toBe(false);
  const budget = { reservationId: ids.request, logicalOperationId: ids.request, attempt: 1, runStepId: ids.task, probe: false };
  const request = buildAgentDecisionRequest(snapshot(), budget, 1234);
  expect(request).toMatchObject({ schemaVersion: 4, instructionVersion: "adaptive-course-agent-v4:text-pdf-parts-v2", maxOutputTokens: 32768 });
  expect(request.trustedInstructions).toContain('read_source {kind:"continue",sourceId}');
  expect(request.trustedInstructions).toContain("first part, title or contents page does not establish");
  expect(request.trustedInstructions).not.toContain("PDF documents cannot be read");
  expect(JSON.stringify(z.toJSONSchema(request.schema))).not.toContain("rawDigest");
});

it("rejects a globally known source ID without an authorized conversation grant during preparation and execution", async () => {
  const { first } = await documents(), test = harness();
  const prepared = await prepareAgentDecision({} as DbTransaction, authority(), continuation(first.id), 0);
  expect(prepared.preparationError).toBe("not_found");
  vi.spyOn(repository, "loadToolAuthority").mockResolvedValue(authority());
  const getSource = vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockResolvedValue(first);
  const result = await test.execute(continuation(first.id));
  expect(result).toMatchObject({ ok: false, sourceIds: [], data: { code: "not_found" } });
  expect(getSource).not.toHaveBeenCalled();
  expect(test.read).not.toHaveBeenCalled();
});

it("rechecks current conversation authority immediately before loading a continuation document", async () => {
  const { first } = await documents(), test = harness();
  const grants = vi.spyOn(repository, "loadToolAuthority").mockResolvedValueOnce(authority([first.id])).mockResolvedValue(authority());
  const getSource = vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockResolvedValue(first);
  expect(await test.execute(continuation(first.id))).toMatchObject({ ok: false, data: { code: "not_found" } });
  expect(grants).toHaveBeenCalledTimes(2);
  expect(grants.mock.calls[1]!.slice(1)).toEqual([target, ids.approval]);
  expect(getSource).not.toHaveBeenCalled();
  expect(test.read).not.toHaveBeenCalled();
});

it("derives each next read from the actual saved document and replays its saved result without refetching", async () => {
  const { first, second, last } = await documents(), test = harness(), granted = new Set([first.id]);
  const docs = new Map([first, second, last].map(document => [document.id, document]));
  vi.spyOn(repository, "loadToolAuthority").mockImplementation(async () => authority(granted));
  const getSource = vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockImplementation(async (_tx, sourceId) => docs.get(sourceId) ?? null);
  const saveSource = vi.spyOn(PostgresResearchRepository.prototype, "saveSource").mockImplementation(async (_tx, document) => {
    granted.add(document.id); return document;
  });
  test.read.mockResolvedValueOnce({ status: "success", document: second }).mockResolvedValueOnce({ status: "success", document: last });
  const capture = snapshot();
  capture.sources = [{ sourceId: first.id, title: "Stale display title", url: "https://untrusted.example/stale.pdf" }];
  const result = await test.execute(continuation(first.id), capture);
  expect(test.read).toHaveBeenNthCalledWith(1, { url: first.requestedUrl, readerPolicy: "text-pdf-parts-v2", continuation: first.pdfPart!.next }, test.context.signal);
  expect(result).toMatchObject({ tool: "read_source", ok: true, sourceIds: [second.id], summary: `Read a part of ${second.title}.`,
    data: { sourceId: second.id, previewOnly: true, pdfPart: { totalPages: 3, hasMore: true, retrieval: "read_source.continue" } } });
  expect(JSON.stringify(result)).not.toContain("rawDigest");
  expect(JSON.stringify(result)).not.toContain("extractorVersion");
  expect(JSON.stringify(test.publicEvents)).not.toContain(first.id);
  expect(JSON.stringify(test.publicEvents)).not.toContain("pdfPart");
  expect(await test.execute(continuation(first.id), capture)).toEqual(result);
  expect(test.read).toHaveBeenCalledTimes(1);
  expect(getSource).toHaveBeenCalledTimes(1);
  expect(saveSource).toHaveBeenCalledTimes(1);
  const final = await test.execute(continuation(second.id), capture, 1);
  expect(test.read).toHaveBeenNthCalledWith(2, { url: second.requestedUrl, readerPolicy: "text-pdf-parts-v2", continuation: second.pdfPart!.next }, test.context.signal);
  expect(final).toMatchObject({ sourceIds: [last.id], data: { sourceId: last.id, pdfPart: { hasMore: false } } });
});

it.each(["text", "last"] as const)("does not fetch when the authorized %s source has no further PDF part", async kind => {
  const source = (await documents())[kind], test = harness();
  vi.spyOn(repository, "loadToolAuthority").mockResolvedValue(authority([source.id]));
  vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockResolvedValue(source);
  expect(await test.execute(continuation(source.id))).toMatchObject({ ok: false, sourceIds: [], data: { code: "no_source_continuation" } });
  expect(test.read).not.toHaveBeenCalled();
});

it("keeps historical URL reads exact and rejects continuation under an old capture", async () => {
  const { text, first } = await documents(), test = harness();
  vi.spyOn(repository, "loadToolAuthority").mockResolvedValue(authority([first.id]));
  vi.spyOn(PostgresResearchRepository.prototype, "saveSource").mockResolvedValue(text);
  const getSource = vi.spyOn(PostgresResearchRepository.prototype, "getSource").mockResolvedValue(first);
  test.read.mockResolvedValue({ status: "success", document: text });
  const urlDecision: AgentDecision = { tool: "read_source", commentary: null, input: { kind: "url", url: text.requestedUrl } };
  const result = await test.execute(urlDecision, snapshot(false));
  expect(test.read).toHaveBeenNthCalledWith(1, { url: text.requestedUrl }, test.context.signal);
  expect(result).toEqual({ tool: "read_source", ok: true, summary: `Read ${text.title}.`, sourceIds: [text.id], artifactIds: [],
    data: { sourceId: text.id, title: text.title, url: text.finalUrl, extractionState: "complete", blockIndex: text.blocks, previewOnly: true } });
  expect(await test.execute(continuation(first.id), snapshot(false), 1)).toMatchObject({ ok: false, data: { code: "invalid_output" } });
  expect(getSource).not.toHaveBeenCalled();
  expect(test.read).toHaveBeenCalledTimes(1);
  await test.execute(urlDecision, snapshot(), 2);
  expect(test.read).toHaveBeenNthCalledWith(2, { url: text.requestedUrl, readerPolicy: "text-pdf-parts-v2" }, test.context.signal);
});

it("retains safe continuation guidance in source memory without treating previews or later parts as read evidence", async () => {
  const { first, last } = await documents();
  const memory = compactSourceMemory([first, last], [first, last].map((document, index) => ({
    stepId: stableExecutionId(ids.task, `read:${index}`), sourceId: document.id, fullyReadBlockIds: [], failedUrl: null, failureStatus: null,
  })));
  expect(memory.sources.map(source => source.pdfPart)).toEqual([
    { totalPages: 3, hasMore: true, retrieval: "read_source.continue" }, { totalPages: 3, hasMore: false, retrieval: "read_source.continue" },
  ]);
  expect(memory.sources.every(source => source.fullyReadBlockCount === 0)).toBe(true);
  expect(memory.previewsAreEvidence).toBe(false);
  expect(JSON.stringify(memory)).not.toContain("rawDigest");
  const capture = { ...snapshot(), sources: [{ sourceId: first.id, title: first.title, url: first.finalUrl }], sourceMemory: memory };
  expect(agentActionDetails(continuation(first.id), capture)).toEqual({ source: { title: first.title, url: first.finalUrl } });
});
