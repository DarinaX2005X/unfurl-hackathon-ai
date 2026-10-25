import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "../../domain/common";
import { ProviderFailure } from "../ai/failure";
import type { SourceDocument } from "../research/ports";

const blockId = z.string().min(1).max(80);
const readStatus = z.enum(["unavailable", "unsupported", "blocked", "too_large"]);
export const ReadMemoryReceiptSchema = z.object({
  stepId: IdSchema, sourceId: IdSchema.nullable(), fullyReadBlockIds: z.array(blockId),
  failedUrl: z.string().max(4096).nullable(), failureStatus: readStatus.nullable(),
}).strict();
export type ReadMemoryReceipt = z.infer<typeof ReadMemoryReceiptSchema>;
export const SourceMemorySchema = z.object({
  sources: z.array(z.object({
    sourceId: IdSchema, contentDigest: DigestSchema, extractionState: z.enum(["complete", "truncated"]),
    blockCount: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative(),
    fullyReadBlockCount: z.number().int().nonnegative(), fullyReadBlockIds: z.array(blockId).nullable(),
    blocks: z.array(z.object({ id: blockId, characters: z.number().int().nonnegative(),
      fullyRead: z.boolean(), preview: z.string().nullable() }).strict()).nullable(),
  }).strict()),
  failedUrlReads: z.array(z.object({ stepId: IdSchema, url: z.string().nullable(), urlPreview: z.string(),
    status: readStatus, attempts: z.number().int().positive() }).strict()),
  overflow: z.boolean(), blockRetrieval: z.literal("read_source.blocks"),
  failedReadRetrieval: z.literal("read_source.saved_read"), previewsAreEvidence: z.literal(false),
  history: z.object({ totalReadReceipts: z.number().int().nonnegative(), omittedSources: z.number().int().nonnegative(),
    omittedFailedUrls: z.number().int().nonnegative(), category: z.literal("source_reads"), offset: z.literal(0),
    retrieval: z.literal("read_source.history") }).strict().optional(),
}).strict();
export type SourceMemory = z.infer<typeof SourceMemorySchema>;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Exact read identities outlive the latest tool. Text previews never become research evidence. */
export function compactSourceMemory(documents: readonly SourceDocument[], receipts: readonly ReadMemoryReceipt[], maximumBytes = 64 * 1024): SourceMemory {
  const read = new Map<string, Set<string>>();
  const failed = new Map<string, SourceMemory["failedUrlReads"][number]>();
  for (const receipt of receipts) {
    if (receipt.sourceId) {
      const ids = read.get(receipt.sourceId) ?? new Set<string>();
      receipt.fullyReadBlockIds.forEach((id) => ids.add(id));
      read.set(receipt.sourceId, ids);
    }
    if (receipt.failedUrl && receipt.failureStatus) {
      const key = `${receipt.failureStatus}:${receipt.failedUrl}`, prior = failed.get(key);
      failed.set(key, { stepId: receipt.stepId, url: receipt.failedUrl,
        urlPreview: Array.from(receipt.failedUrl).slice(0, 100).join(""), status: receipt.failureStatus, attempts: (prior?.attempts ?? 0) + 1 });
    }
  }
  const selected = documents.filter((document) => read.has(document.id));
  if (selected.length !== read.size) throw new ProviderFailure("invalid_output");
  for (const document of selected) {
    const valid = new Set(document.blocks.map((block) => block.id));
    if (Array.from(read.get(document.id)!).some((id) => !valid.has(id))) throw new ProviderFailure("invalid_output");
  }
  const failures = Array.from(failed.values());
  const result: SourceMemory = { sources: selected.map((document) => ({
    sourceId: document.id, contentDigest: document.contentDigest, extractionState: document.extractionState,
    blockCount: document.blocks.length, totalCharacters: document.blocks.reduce((total, block) => total + block.text.length, 0),
    fullyReadBlockCount: read.get(document.id)!.size, fullyReadBlockIds: read.get(document.id)!.size ? null : [], blocks: null,
  })), failedUrlReads: failures.map((failure) => ({ ...failure, url: null })), overflow: true,
  blockRetrieval: "read_source.blocks", failedReadRetrieval: "read_source.saved_read", previewsAreEvidence: false };
  while (bytes(result) > maximumBytes && (result.sources.length || result.failedUrlReads.length)) {
    if (result.failedUrlReads.length >= result.sources.length) result.failedUrlReads.shift();
    else result.sources.shift();
    result.history = { totalReadReceipts: receipts.length, omittedSources: selected.length - result.sources.length,
      omittedFailedUrls: failures.length - result.failedUrlReads.length, category: "source_reads", offset: 0, retrieval: "read_source.history" };
  }
  if (bytes(result) > maximumBytes) throw new ProviderFailure("invalid_output");
  const retainedDocuments = new Map(selected.map((document) => [document.id, document]));
  const retainedFailures = new Map(failures.map((failure) => [failure.stepId, failure]));
  // Retain read coverage and every source's exact index before spending space on previews.
  for (const source of result.sources) {
    source.fullyReadBlockIds = Array.from(read.get(source.sourceId)!);
    if (bytes(result) > maximumBytes) source.fullyReadBlockIds = null;
  }
  for (const failure of result.failedUrlReads) {
    failure.url = retainedFailures.get(failure.stepId)!.url;
    if (bytes(result) > maximumBytes) failure.url = null;
  }
  for (const source of result.sources) {
    const document = retainedDocuments.get(source.sourceId)!;
    source.blocks = document.blocks.map((block) => ({ id: block.id, characters: block.text.length,
      fullyRead: read.get(document.id)!.has(block.id), preview: null }));
    if (bytes(result) > maximumBytes) source.blocks = null;
  }
  for (const source of result.sources) {
    const document = retainedDocuments.get(source.sourceId)!;
    for (const [blockIndex, block] of (source.blocks ?? []).entries()) {
      block.preview = Array.from(document.blocks[blockIndex]!.text).slice(0, 160).join("");
      if (bytes(result) > maximumBytes) block.preview = null;
    }
  }
  result.overflow = !!result.history || result.sources.some((source) => source.blocks === null || source.fullyReadBlockIds === null || source.blocks.some((block) => block.preview === null))
    || result.failedUrlReads.some((failure) => failure.url === null);
  return SourceMemorySchema.parse(result);
}
