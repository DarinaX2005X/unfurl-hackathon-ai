import "server-only";
import type { DbTransaction } from "../db";
import { canonicalJson, jsonDigest } from "../ai/json";
import { ProviderFailure } from "../ai/failure";
import { PassageSchema, SearchResultSchema, SourceDocumentSchema, type Passage, type SearchResult, type SourceDocument } from "./ports";

type DateValue = Date | string;
interface SourceRow {
  id: string; requested_url: string; final_url: string; title: string; retrieved_at: DateValue; published_at: DateValue | null;
  media_type: string; raw_digest: string; extractor_version: string; content_digest: string; blocks: unknown; extraction_state: string;
}
interface PassageRow { id: string; source_id: string; block_id: string; start_utf16: number; end_utf16: number; quote: string }
interface SearchRow { id: string; operation_id: string; requested_query: string; executed_query: string | null;
  content_language: string; retrieved_at: DateValue; hits: unknown; limitations: unknown; request_digest: string; provider_request_id: string }
const conflict = () => new ProviderFailure("invalid_output");
function source(row: SourceRow): SourceDocument {
  const result = SourceDocumentSchema.parse({ id: row.id, requestedUrl: row.requested_url, finalUrl: row.final_url, title: row.title,
    retrievedAt: new Date(row.retrieved_at).toISOString(), publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    mediaType: row.media_type, rawDigest: row.raw_digest, extractorVersion: row.extractor_version, contentDigest: row.content_digest,
    blocks: row.blocks, extractionState: row.extraction_state });
  if (jsonDigest(result.blocks, 2 * 1024 * 1024) !== result.contentDigest) throw conflict();
  return result;
}
function passage(row: PassageRow): Passage {
  return PassageSchema.parse({ id: row.id, sourceId: row.source_id, blockId: row.block_id, start: row.start_utf16, end: row.end_utf16, quote: row.quote });
}
function search(row: SearchRow): SearchResult {
  return SearchResultSchema.parse({ id: row.id, operationId: row.operation_id, provider: "openrouter:parallel", providerRequestId: row.provider_request_id,
    requestedQuery: row.requested_query, executedQuery: row.executed_query, contentLanguage: row.content_language,
    retrievedAt: new Date(row.retrieved_at).toISOString(), hits: row.hits, limitations: row.limitations, requestDigest: row.request_digest });
}
export function verifyPassage(document: SourceDocument, value: Passage): void {
  const parsed = PassageSchema.parse(value);
  const block = document.blocks.find((item) => item.id === parsed.blockId);
  if (parsed.sourceId !== document.id || !block || parsed.end > block.text.length || block.text.slice(parsed.start, parsed.end) !== parsed.quote) throw conflict();
}

/** Producers take the caller's guarded step transaction. No course links or access grants are inferred. */
export class PostgresResearchRepository {
  async getSources(tx: DbTransaction, ids: readonly string[]): Promise<SourceDocument[]> {
    if (ids.length === 0) return [];
    const rows = (await tx.query<SourceRow>("SELECT * FROM unfurl.research_source_documents WHERE id=ANY($1::uuid[])", [[...new Set(ids)]])).rows;
    const documents = new Map(rows.map((row) => { const value = source(row); return [value.id, value] as const; }));
    return ids.map((id) => { const value = documents.get(id); if (!value) throw conflict(); return value; });
  }
  async getPassages(tx: DbTransaction, ids: readonly string[]): Promise<Passage[]> {
    if (ids.length === 0) return [];
    const rows = (await tx.query<PassageRow>("SELECT * FROM unfurl.research_passages WHERE id=ANY($1::uuid[])", [[...new Set(ids)]])).rows;
    const passages = new Map(rows.map((row) => { const value = passage(row); return [value.id, value] as const; }));
    const documents = new Map((await this.getSources(tx, [...new Set(rows.map((row) => row.source_id))])).map((value) => [value.id, value]));
    return ids.map((id) => {
      const value = passages.get(id);
      const document = value ? documents.get(value.sourceId) : null;
      if (!value || !document) throw conflict();
      verifyPassage(document, value);
      return value;
    });
  }
  async getSource(tx: DbTransaction, id: string): Promise<SourceDocument | null> {
    const row = (await tx.query<SourceRow>("SELECT * FROM unfurl.research_source_documents WHERE id=$1", [id])).rows[0];
    return row ? source(row) : null;
  }
  async saveSource(tx: DbTransaction, document: SourceDocument): Promise<SourceDocument> {
    const value = SourceDocumentSchema.parse(document);
    if (jsonDigest(value.blocks, 2 * 1024 * 1024) !== value.contentDigest) throw conflict();
    await tx.query(`INSERT INTO unfurl.research_source_documents
      (id,requested_url,final_url,title,retrieved_at,published_at,media_type,raw_digest,extractor_version,content_digest,blocks,extraction_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
    [value.id, value.requestedUrl, value.finalUrl, value.title, value.retrievedAt, value.publishedAt, value.mediaType,
      value.rawDigest, value.extractorVersion, value.contentDigest, JSON.stringify(value.blocks), value.extractionState]);
    const stored = await this.getSource(tx, value.id);
    if (!stored || canonicalJson(stored, 3 * 1024 * 1024) !== canonicalJson(value, 3 * 1024 * 1024)) throw conflict();
    return stored;
  }
  async getPassage(tx: DbTransaction, id: string): Promise<Passage | null> {
    const row = (await tx.query<PassageRow>("SELECT * FROM unfurl.research_passages WHERE id=$1", [id])).rows[0];
    if (!row) return null;
    const result = passage(row);
    const document = await this.getSource(tx, result.sourceId);
    if (!document) throw conflict();
    verifyPassage(document, result);
    return result;
  }
  async savePassage(tx: DbTransaction, input: Passage): Promise<Passage> {
    const value = PassageSchema.parse(input);
    const document = await this.getSource(tx, value.sourceId);
    if (!document) throw conflict();
    verifyPassage(document, value);
    await tx.query(`INSERT INTO unfurl.research_passages (id,source_id,block_id,start_utf16,end_utf16,quote)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [value.id, value.sourceId, value.blockId, value.start, value.end, value.quote]);
    const rows = (await tx.query<PassageRow>(`SELECT * FROM unfurl.research_passages WHERE id=$1 OR
      (source_id=$2 AND block_id=$3 AND start_utf16=$4 AND end_utf16=$5)`, [value.id, value.sourceId, value.blockId, value.start, value.end])).rows;
    if (rows.length !== 1) throw conflict();
    const stored = passage(rows[0]!);
    if (stored.sourceId !== value.sourceId || stored.blockId !== value.blockId || stored.start !== value.start || stored.end !== value.end || stored.quote !== value.quote) throw conflict();
    return stored;
  }
  async getSearch(tx: DbTransaction, id: string): Promise<SearchResult | null> {
    const row = (await tx.query<SearchRow>("SELECT * FROM unfurl.research_searches WHERE id=$1", [id])).rows[0];
    return row ? search(row) : null;
  }
  async saveSearch(tx: DbTransaction, input: SearchResult): Promise<SearchResult> {
    const value = SearchResultSchema.parse(input);
    const paid = (await tx.query<{ id: string }>(`SELECT o.id FROM unfurl.ai_provider_operations o
      JOIN unfurl.ai_provider_responses r ON r.operation_id=o.id
      WHERE o.id=$1 AND o.state IN ('unknown','settled') AND o.purpose IN ('web_search','capability_probe')
      AND r.provider_request_id=$2`, [value.operationId, value.providerRequestId])).rows[0];
    if (!paid) throw conflict();
    await tx.query(`INSERT INTO unfurl.research_searches
      (id,operation_id,requested_query,executed_query,content_language,retrieved_at,hits,limitations,request_digest,provider_request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [value.id, value.operationId, value.requestedQuery, value.executedQuery, value.contentLanguage, value.retrievedAt,
      JSON.stringify(value.hits), JSON.stringify(value.limitations), value.requestDigest, value.providerRequestId]);
    const stored = await this.getSearch(tx, value.id);
    if (!stored || canonicalJson(stored, 256 * 1024) !== canonicalJson(value, 256 * 1024)) throw conflict();
    return stored;
  }
}
