import "server-only";
import { InvestigationSourceSchema, SourceInvestigationConfigSchema } from "@/domain/mechanic-families/v2/investigation";
import { SourceInvestigationPrivateSchema } from "@/server/evaluation/investigation";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import type { PreparedTaskCandidate } from "@/server/mechanics/contracts";
import { taskDigest } from "@/server/mechanics/digest";

type SourceFacts = Pick<CurriculumEvidenceFacts, "sources" | "passages" | "claims">;
/** Authoring and validation use the same immutable snapshots. Incompatible passages are never shortened or rewritten. */
export function projectCanonicalResearchSources(facts: SourceFacts) {
  const sources = [], unavailableSourceIds: string[] = [];
  for (const source of facts.sources) {
    const passages = facts.passages.filter((passage) => passage.sourceId === source.id);
    if (!passages.length) continue;
    const parsed = InvestigationSourceSchema.safeParse({ id: source.id, url: source.finalUrl, title: source.title,
      retrievedAt: source.retrievedAt, contentDigest: source.contentDigest, passages: passages.map((passage) => ({ id: passage.id, text: passage.quote })) });
    if (parsed.success) sources.push(parsed.data);
    else unavailableSourceIds.push(source.id);
  }
  return { sources, unavailableSourceIds };
}

/** Returns repairable findings before a source-grounding receipt can pass. */
export function inspectCandidateSourceGrounding(candidate: PreparedTaskCandidate, facts: SourceFacts) {
  const projection = projectCanonicalResearchSources(facts), issues: string[] = [];
  const representedPassages = new Set(projection.sources.flatMap((source) => source.passages.map((passage) => passage.id)));
  for (const claimId of candidate.privateTask.sourceClaimIds) {
    const claim = facts.claims.find((entry) => entry.id === claimId);
    if (!claim || claim.passageIds.some((id) => !representedPassages.has(id))) issues.push(`Claim ${claimId} has no complete compatible canonical source snapshot.`);
  }
  if (candidate.task.mechanicId === "source_investigation") {
    const config = SourceInvestigationConfigSchema.parse(candidate.task.config), privateData = SourceInvestigationPrivateSchema.parse(candidate.privateTask.evaluatorData);
    for (const snapshot of [...config.sources, ...privateData.sources]) {
      const canonical = projection.sources.find((source) => source.id === snapshot.id);
      if (!canonical || taskDigest(snapshot) !== taskDigest(canonical)) issues.push(`Source snapshot ${snapshot.id} differs from the canonical stored source; copy its exact metadata and passage list.`);
    }
  }
  return { ...projection, issues: [...new Set(issues)] };
}
