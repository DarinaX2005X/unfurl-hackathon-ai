import "server-only";
import { z } from "zod";
import { ProviderFailure } from "@/server/ai/failure";
import { jsonDigest } from "@/server/ai/json";
import { SourceDocumentSchema, type SourceDocument } from "@/server/research/ports";
import { SourceSpanClaimsProposalSchema } from "./checkpoints";
import { projectSourceClaimIdentities } from "./source-claim-identities";

export const SOURCE_SPAN_MAX_UTF16 = 4000;
export type SourceSpan = Readonly<{ id: string; blockId: string; start: number; end: number; quote: string }>;
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

/** Versioned deterministic partition: no omission, normalization or page joining. */
export function createSourceSpansV2(document: SourceDocument): readonly SourceSpan[] {
  const source = SourceDocumentSchema.parse(document);
  if (jsonDigest(source.blocks, 2 * 1024 * 1024) !== source.contentDigest) return invalid();
  const spans: SourceSpan[] = [];
  for (const block of source.blocks) {
    for (let start = 0; start < block.text.length;) {
      let end = Math.min(start + SOURCE_SPAN_MAX_UTF16, block.text.length);
      if (end < block.text.length) {
        const preferredStart = start + Math.floor(SOURCE_SPAN_MAX_UTF16 / 2);
        const newline = block.text.lastIndexOf("\n", end - 1);
        if (newline >= preferredStart) end = newline + 1;
        else for (let position = end - 1; position >= preferredStart; position--) {
          if (/\s/u.test(block.text[position]!)) { end = position + 1; break; }
        }
        const before = block.text.charCodeAt(end - 1), after = block.text.charCodeAt(end);
        if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
      }
      spans.push(Object.freeze({ id: `span-${spans.length + 1}`, blockId: block.id, start, end, quote: block.text.slice(start, end) }));
      start = end;
    }
  }
  return Object.freeze(spans);
}

/** Every source character is supplied once, with server-owned selection coordinates. */
export function sourceSpanDocumentV2(document: SourceDocument) {
  const { blocks: _blocks, ...metadata } = document; void _blocks;
  return { ...metadata, spans: createSourceSpansV2(document) };
}

export function sourceSpanClaimsResponseSchema(spans: readonly SourceSpan[]) {
  if (!spans.length || new Set(spans.map(span => span.id)).size !== spans.length) return invalid();
  return SourceSpanClaimsProposalSchema.extend({ passages: z.array(SourceSpanClaimsProposalSchema.shape.passages.element.extend({
    sourceSpanId: z.enum(spans.map(span => span.id) as [string, ...string[]]),
  })).min(1) });
}

/** A selection can only resolve to exact text in this saved document. */
export function projectSourceSpanClaimsV2(raw: z.infer<typeof SourceSpanClaimsProposalSchema>, document: SourceDocument, stepId: string) {
  const spans = createSourceSpansV2(document), proposal = sourceSpanClaimsResponseSchema(spans).parse(raw);
  const byId = new Map(spans.map(span => [span.id, span]));
  return projectSourceClaimIdentities({ claims: proposal.claims, passages: proposal.passages.map(passage => {
    const span = byId.get(passage.sourceSpanId) ?? invalid();
    return { id: passage.id, sourceId: document.id, blockId: span.blockId, start: span.start, end: span.end, quote: span.quote };
  }) }, stepId);
}
