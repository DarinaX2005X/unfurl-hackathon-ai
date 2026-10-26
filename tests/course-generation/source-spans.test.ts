import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { jsonDigest } from "@/server/ai/json";
import { SourceSpanClaimsProposalSchema } from "@/server/course-generation/checkpoints";
import { createSourceSpansV2, projectSourceSpanClaimsV2, sourceSpanClaimsResponseSchema, sourceSpanDocumentV2 } from "@/server/course-generation/source-spans";
import { verifyPassage } from "@/server/research/repository";
import { fixture, id } from "./fixtures";

function sourceWithText(texts: string[]) {
  const source = structuredClone(fixture().source);
  source.blocks = texts.map((text, index) => ({ id: `page-${index + 1}`, text }));
  source.contentDigest = jsonDigest(source.blocks, 2 * 1024 * 1024);
  return source;
}

it("partitions every source block exactly without trimming whitespace or joining pages", () => {
  const source = sourceWithText(["  beginning\n" + "a".repeat(3100) + "\n" + "b ".repeat(4000) + "\nend  ", "\n second page\r\n\t", "z".repeat(3999) + "😀" + "tail"]);
  const spans = createSourceSpansV2(source);
  expect(createSourceSpansV2(source)).toEqual(spans);
  for (const block of source.blocks) {
    const pieces = spans.filter(span => span.blockId === block.id);
    expect(pieces.map(span => span.quote).join("")).toBe(block.text);
    expect(pieces[0]!.start).toBe(0); expect(pieces.at(-1)!.end).toBe(block.text.length);
    pieces.forEach((span, index) => {
      expect(span.quote.length).toBeGreaterThan(0); expect(span.quote.length).toBeLessThanOrEqual(4000);
      expect(block.text.slice(span.start, span.end)).toBe(span.quote);
      if (index) expect(span.start).toBe(pieces[index - 1]!.end);
    });
  }
  const emoji = spans.filter(span => span.blockId === "page-3");
  expect(emoji[0]!.end).toBe(3999); expect(emoji[1]!.quote).toBe("😀tail");
  expect(spans[0]!.quote.endsWith("\n")).toBe(true);
  expect(Object.isFrozen(spans)).toBe(true); expect(Object.isFrozen(spans[0])).toBe(true);
});

it("supplies all spans from all blocks without a total count limit or duplicate original blocks", () => {
  const source = sourceWithText(Array.from({ length: 70 }, (_, index) => `${index}:` + "complete text ".repeat(130)));
  const document = sourceSpanDocumentV2(source);
  expect(document).not.toHaveProperty("blocks"); expect(document.spans).toHaveLength(70);
  expect(document.spans.map(span => span.quote).join("")).toBe(source.blocks.map(block => block.text).join(""));
  expect(new Set(document.spans.map(span => span.id)).size).toBe(document.spans.length);
});

it("allows only actual span IDs and excludes model-authored text or coordinates", () => {
  const source = sourceWithText(["First page", "Second page"]), spans = createSourceSpansV2(source);
  const claim = fixture().claims[0]!;
  const { ownerId: _owner, runStepId: _run, createdAt: _created, ...rawClaim } = claim; void _owner; void _run; void _created;
  const raw = { passages: [{ id: "one", sourceSpanId: spans[0]!.id }], claims: [{ ...rawClaim, id: "claim", passageIds: ["one"] }] };
  expect(sourceSpanClaimsResponseSchema(spans).safeParse(raw).success).toBe(true);
  expect(sourceSpanClaimsResponseSchema(spans).safeParse({ ...raw, passages: [{ id: "one", sourceSpanId: "span-3" }] }).success).toBe(false);
  expect(SourceSpanClaimsProposalSchema.safeParse({ ...raw, passages: [{ ...raw.passages[0], quote: "invented", start: 0, end: 8 }] }).success).toBe(false);
});

it("retains exact separate page fragments supporting one claim, including source footers and line wraps", () => {
  const source = sourceWithText(["broadcasting starts here\n276. Source footer", "and continues on this page.\n", "vectoriza-\ntion begins", " continues here\n"]);
  const claim = fixture().claims[0]!;
  const { ownerId: _owner, runStepId: _run, createdAt: _created, ...rawClaim } = claim; void _owner; void _run; void _created;
  const passages = createSourceSpansV2(source).map(span => ({ id: `passage-${span.id}`, sourceSpanId: span.id }));
  const raw = { passages, claims: [{ ...rawClaim, id: "claim", passageIds: passages.map(passage => passage.id) }] };
  const projected = projectSourceSpanClaimsV2(raw, source, id(813));
  expect(projected.passages.map(passage => passage.quote)).toEqual(source.blocks.map(block => block.text));
  expect(projected.claims[0]!.passageIds).toEqual(projected.passages.map(passage => passage.id));
  projected.passages.forEach(passage => expect(() => verifyPassage(source, passage)).not.toThrow());
  expect(projectSourceSpanClaimsV2(raw, source, id(813))).toEqual(projected);
  expect(projectSourceSpanClaimsV2(raw, source, id(814)).passages[0]!.id).not.toBe(projected.passages[0]!.id);
});

it("rejects a modified document digest and dangling local passage references", () => {
  const source = sourceWithText(["Original source"]);
  source.blocks[0]!.text = "Modified source";
  expect(() => createSourceSpansV2(source)).toThrow("provider.invalid_output");
  source.contentDigest = jsonDigest(source.blocks, 2 * 1024 * 1024);
  const claim = fixture().claims[0]!;
  const { ownerId: _owner, runStepId: _run, createdAt: _created, ...rawClaim } = claim; void _owner; void _run; void _created;
  expect(() => projectSourceSpanClaimsV2({ passages: [{ id: "p1", sourceSpanId: "span-1" }], claims: [{ ...rawClaim, id: "claim", passageIds: ["unknown"] }] }, source, id(813))).toThrow("provider.invalid_output");
});
