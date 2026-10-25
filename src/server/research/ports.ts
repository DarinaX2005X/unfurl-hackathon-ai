import "server-only";
import { z } from "zod";
import { ContentLanguageSchema, DigestSchema, IdSchema, IsoDateTimeSchema } from "../../domain/common";

export const SourceUrlSchema = z.string().min(1).max(4096).refine((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
});
export const SourceBlockSchema = z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(20000) }).strict();
export const SourceDocumentSchema = z.object({
  id: IdSchema, requestedUrl: SourceUrlSchema, finalUrl: SourceUrlSchema, title: z.string().trim().min(1).max(1000),
  retrievedAt: IsoDateTimeSchema, publishedAt: IsoDateTimeSchema.nullable(),
  mediaType: z.enum(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"]),
  rawDigest: DigestSchema, extractorVersion: z.string().min(1).max(80), contentDigest: DigestSchema,
  blocks: z.array(SourceBlockSchema).min(1).max(512), extractionState: z.enum(["complete", "truncated"]),
}).strict().superRefine((document, ctx) => {
  if (document.blocks.reduce((total, block) => total + block.text.length, 0) > 200000 || new Set(document.blocks.map((block) => block.id)).size !== document.blocks.length) {
    ctx.addIssue({ code: "custom", path: ["blocks"], message: "Source blocks must be unique and bounded" });
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
export type Passage = z.infer<typeof PassageSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type SourceReadResult = { status: "success"; document: SourceDocument }
  | { status: "unavailable" | "unsupported" | "blocked" | "too_large"; requestedUrl: string };
export interface ResearchPort {
  search(input: SearchInput, signal: AbortSignal): Promise<SearchResult>;
  read(input: { url: string }, signal: AbortSignal): Promise<SourceReadResult>;
}
