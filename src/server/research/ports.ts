import "server-only";
import { z } from "zod";
import { ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema } from "../../domain/common";

export const SourceUrlSchema = z.string().min(1).max(4096).refine((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
});
export const SourceBlockSchema = z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(20000) }).strict();
export const PDF_EXTRACTOR_VERSION = "pdfjs-6.4.299-text-v1" as const;
const PdfPositionSchema = z.object({ page: z.number().int().positive(), offset: z.number().int().nonnegative() }).strict();
export const PdfContinuationSchema = z.object({
  kind: z.literal("pdf-text-v1"), rawDigest: DigestSchema, extractorVersion: z.literal(PDF_EXTRACTOR_VERSION),
  totalPages: z.number().int().positive(), page: z.number().int().positive(), offset: z.number().int().nonnegative(),
}).strict().refine(value => value.page <= value.totalPages, "PDF continuation must name an existing page");
export const PdfPartSchema = z.object({
  kind: z.literal("pdf-text-v1"), totalPages: z.number().int().positive(),
  start: PdfPositionSchema, end: PdfPositionSchema, next: PdfContinuationSchema.nullable(),
}).strict();
export type PdfContinuation = z.infer<typeof PdfContinuationSchema>;
export type PdfPart = z.infer<typeof PdfPartSchema>;
export const SourceReadInputSchema = z.object({
  url: SourceUrlSchema, readerPolicy: z.literal("text-pdf-parts-v2").optional(), continuation: PdfContinuationSchema.optional(),
}).strict().refine(value => !value.continuation || value.readerPolicy === "text-pdf-parts-v2", "PDF continuation requires its captured reader policy");
export type SourceReadInput = z.infer<typeof SourceReadInputSchema>;
export const SourceDocumentSchema = z.object({
  id: IdSchema, requestedUrl: SourceUrlSchema, finalUrl: SourceUrlSchema, title: z.string().trim().min(1).max(1000),
  retrievedAt: IsoDateTimeSchema, publishedAt: IsoDateTimeSchema.nullable(),
  mediaType: z.enum(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json", "application/pdf"]),
  rawDigest: DigestSchema, extractorVersion: z.string().min(1).max(80), contentDigest: DigestSchema,
  blocks: z.array(SourceBlockSchema).min(1).max(512), extractionState: z.enum(["complete", "truncated"]), pdfPart: PdfPartSchema.optional(),
}).strict().superRefine((document, ctx) => {
  if (document.blocks.reduce((total, block) => total + block.text.length, 0) > 200000 || new Set(document.blocks.map((block) => block.id)).size !== document.blocks.length) {
    ctx.addIssue({ code: "custom", path: ["blocks"], message: "Source blocks must be unique and bounded" });
  }
  const part = document.pdfPart;
  if (document.mediaType !== "application/pdf") {
    if (part) ctx.addIssue({ code: "custom", path: ["pdfPart"], message: "Only PDF sources carry PDF parts" });
    return;
  }
  if (!part || document.extractorVersion !== PDF_EXTRACTOR_VERSION) {
    ctx.addIssue({ code: "custom", path: ["pdfPart"], message: "PDF sources require exact extractor and part provenance" }); return;
  }
  const after = (a: {page:number;offset:number}, b: {page:number;offset:number}) => a.page > b.page || a.page === b.page && a.offset > b.offset;
  if (part.start.page > part.totalPages || part.end.page > part.totalPages || !after(part.end, part.start) ||
      (part.next && (part.next.rawDigest !== document.rawDigest || part.next.extractorVersion !== document.extractorVersion ||
        part.next.totalPages !== part.totalPages || !after(part.next, part.start) || after(part.end, part.next))) ||
      document.extractionState !== (part.start.page === 1 && part.start.offset === 0 && part.next === null ? "complete" : "truncated")) {
    ctx.addIssue({ code: "custom", path: ["pdfPart"], message: "PDF part progress and immutable source identity must agree" });
  }
  for (const block of document.blocks) {
    const position = /^page-(\d+)-offset-(\d+)$/.exec(block.id);
    if (!position) { ctx.addIssue({ code: "custom", path: ["blocks"], message: "PDF blocks require page and UTF-16 offset provenance" }); continue; }
    const start = {page: Number(position[1]), offset: Number(position[2])};
    const end = {page: start.page, offset: start.offset + block.text.length};
    if (!Number.isSafeInteger(start.page) || !Number.isSafeInteger(start.offset) || start.page < 1 ||
        after(part.start, start) || after(end, part.end)) ctx.addIssue({ code: "custom", path: ["blocks"], message: "PDF block lies outside its saved part" });
  }
});
export const PassageSchema = z.object({ id: IdSchema, sourceId: IdSchema, blockId: z.string().min(1).max(80),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(20000) }).strict()
  .refine((passage) => passage.end > passage.start, "A passage must be nonempty");
export const SearchHitSchema = z.object({ id: IdSchema, url: SourceUrlSchema, title: z.string().min(1).max(1000),
  snippet: z.string().max(12000), publishedAt: IsoDateTimeSchema.nullable() }).strict();
export const SearchResultSchema = z.object({
  id: IdSchema, operationId: IdSchema, provider: z.literal("openrouter:parallel"), providerRequestId: z.string().min(1).max(256),
  requestedQuery: z.string().trim().min(1).max(2000), executedQuery: z.string().min(1).max(2000).nullable(),
  contentLanguage: ContentLanguageSchema, retrievedAt: IsoDateTimeSchema,
  hits: z.array(SearchHitSchema).max(5), limitations: z.array(z.enum([
    "executed_query_unavailable", "publication_dates_unavailable", "date_filter_unverified", "empty_search_results", "snippets_are_not_read_sources",
  ])).max(16), requestDigest: DigestSchema,
}).strict();
export const SearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2000), language: ContentLanguageSchema,
  domainHints: z.array(z.string().trim().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)).max(10).optional(),
  publishedAfter: IsoDateTimeSchema.optional(), limit: z.number().int().min(1).max(5),
}).strict();
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
/** Call only after the caller has established access to the saved source. The
 * model never supplies an arbitrary continuation or replaces its source URL. */
export function continuationFromSource(document: SourceDocument): SourceReadInput | null {
  const saved = SourceDocumentSchema.parse(document);
  return saved.pdfPart?.next ? {url: saved.requestedUrl, readerPolicy: "text-pdf-parts-v2", continuation: saved.pdfPart.next} : null;
}
export type Passage = z.infer<typeof PassageSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type SourceReadResult = { status: "success"; document: SourceDocument }
  | { status: "unavailable" | "unsupported" | "blocked" | "too_large"; requestedUrl: string };
export interface ResearchPort {
  search(input: SearchInput, signal: AbortSignal): Promise<SearchResult>;
  read(input: SourceReadInput, signal: AbortSignal): Promise<SourceReadResult>;
}
