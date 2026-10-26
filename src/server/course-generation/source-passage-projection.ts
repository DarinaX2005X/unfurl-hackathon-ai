import "server-only";
import { ProviderFailure } from "@/server/ai/failure";
import { PassageSchema, type Passage, type SourceDocument } from "@/server/research/ports";
import { verifyPassage } from "@/server/research/repository";

/** Raw model proposals remain immutable. Only exact, source-bound coordinates are projected. */
export function projectSourcePassages(document: SourceDocument, proposals: readonly Passage[]): Passage[] {
  const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
  if (new Set(proposals.map(passage => passage.id)).size !== proposals.length) invalid();
  return proposals.map(proposal => {
    const passage = PassageSchema.parse(proposal);
    const block = document.blocks.find(item => item.id === passage.blockId);
    if (passage.sourceId !== document.id || !block) return invalid();
    // A valid original range identifies the intended occurrence even if the quote repeats.
    if (passage.end <= block.text.length && block.text.slice(passage.start, passage.end) === passage.quote) {
      verifyPassage(document, passage);
      return passage;
    }
    const start = block.text.indexOf(passage.quote);
    if (start < 0 || block.text.indexOf(passage.quote, start + 1) !== -1) return invalid();
    const projected = { ...passage, start, end: start + passage.quote.length };
    verifyPassage(document, projected);
    return projected;
  });
}
