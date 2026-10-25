import "server-only";
import { curriculumDigest, type CurriculumDraft, type ModuleOutline, type Outcome } from "../../domain/course";
import { CurriculumEvidencePublicSchema, type CurriculumEvidencePublic } from "../../domain/curriculum-authoring";
import { jsonDigest } from "../ai/json";
import { answerDigest, questionDigest } from "../curricula/changes";
import { PassageSchema, SourceDocumentSchema, type Passage, type SourceDocument } from "../research/ports";
import { CurriculumResearchEvidenceSchema, SourceClaimSchema, type CurriculumResearchEvidence, type ResearchValidationIssue, type SourceClaim } from "./contracts";

export const outcomeEvidenceDigest = (outcome: Outcome): string => jsonDigest(outcome);
export const moduleEvidenceDigest = (module: ModuleOutline): string => jsonDigest(module);
export const briefEvidenceDigest = (draft: CurriculumDraft): string => jsonDigest({
  goal: draft.goal, audience: draft.audience, assumedKnowledge: draft.assumedKnowledge, contentLanguage: draft.contentLanguage,
});

export interface CurriculumEvidenceFacts {
  ownerId: string;
  /** Derived from guarded research steps or this owner's saved revisions, never from model arguments. */
  authorizedSourceIds: ReadonlySet<string>;
  sources: readonly SourceDocument[];
  passages: readonly Passage[];
  claims: readonly SourceClaim[];
}

export async function validateCurriculumEvidence(
  draft: CurriculumDraft, value: CurriculumResearchEvidence, facts: CurriculumEvidenceFacts,
): Promise<ResearchValidationIssue[]> {
  const issues: ResearchValidationIssue[] = [];
  const add = (code: ResearchValidationIssue["code"], path: ResearchValidationIssue["path"], message: string) => issues.push({ code, path, message });
  const parsed = CurriculumResearchEvidenceSchema.safeParse(value);
  const sourcesParsed = SourceDocumentSchema.array().safeParse(facts.sources);
  const passagesParsed = PassageSchema.array().safeParse(facts.passages);
  const claimsParsed = SourceClaimSchema.array().safeParse(facts.claims);
  if (!parsed.success || !sourcesParsed.success || !passagesParsed.success || !claimsParsed.success) {
    return [{ code: "invalid_shape", path: [], message: "Stored research must match its schema" }];
  }
  const evidence = parsed.data;
  if (evidence.contentDigest !== await curriculumDigest(draft)) add("stale_evidence", ["contentDigest"], "Research belongs to different curriculum content");
  if (evidence.briefDigest !== briefEvidenceDigest(draft)) add("stale_evidence", ["briefDigest"], "Research must account for the current goal, audience, prerequisites and language");
  const sources = new Map(sourcesParsed.data.map((source) => [source.id, source]));
  const passages = new Map(passagesParsed.data.map((passage) => [passage.id, passage]));
  const claims = new Map(claimsParsed.data.map((claim) => [claim.id, claim]));
  const outcomes = new Map(draft.outcomes.map((outcome) => [outcome.id, outcome]));
  const modules = new Map(draft.modules.map((module) => [module.id, module]));
  const draftSources = new Set(draft.sourceIds);
  if (sources.size !== facts.sources.length || passages.size !== facts.passages.length || claims.size !== facts.claims.length) {
    add("duplicate_reference", [], "Stored evidence identities must be unique");
  }
  for (const sourceId of draft.sourceIds) {
    if (!facts.authorizedSourceIds.has(sourceId)) add("unauthorized_source", ["sourceIds"], "This source is outside the authorized research scope");
    if (!sources.has(sourceId)) add("unknown_source", ["sourceIds"], "A citation must identify an actually read source");
  }
  if (draft.sourceIds.length === 0) add("unknown_source", ["sourceIds"], "A researched curriculum needs read sources");

  function checkClaim(id: string, path: Array<string | number>, outcomeId?: string): void {
    const claim = claims.get(id);
    if (!claim) { add("unknown_claim", path, "The evidence claim does not exist"); return; }
    if (claim.ownerId !== facts.ownerId) add("unauthorized_claim", path, "The evidence belongs to another account");
    if (outcomeId && !claim.outcomeIds.includes(outcomeId)) add("uncovered_outcome", path, "The claim is not linked to this learning outcome");
    if (new Set(claim.passageIds).size !== claim.passageIds.length || new Set(claim.outcomeIds).size !== claim.outcomeIds.length) {
      add("duplicate_reference", path, "Claim references must be unique");
    }
    if (claim.unresolvedConflicts.some((conflict) => conflict.blocking)) add("unresolved_conflict", path, "Resolve the conflicting evidence before approval");
    claim.passageIds.forEach((passageId) => {
      const passage = passages.get(passageId);
      const source = passage ? sources.get(passage.sourceId) : undefined;
      const block = source?.blocks.find((item) => item.id === passage?.blockId);
      if (!passage || !source || !block || passage.end > block.text.length || block.text.slice(passage.start, passage.end) !== passage.quote) {
        add("invalid_passage", path, "A passage must exactly match its stored source and UTF-16 boundaries");
        return;
      }
      if (!draftSources.has(source.id)) add("unknown_source", path, "The supporting source is missing from this curriculum");
      if (!facts.authorizedSourceIds.has(source.id)) add("unauthorized_source", path, "The supporting source is outside the authorized research scope");
    });
  }

  const coveredOutcomes = new Set<string>();
  evidence.outcomeEvidence.forEach((entry, index) => {
    const path = ["outcomeEvidence", index];
    if (coveredOutcomes.has(entry.outcomeId) || new Set(entry.claimIds).size !== entry.claimIds.length) add("duplicate_reference", path, "Outcome evidence must be unique");
    coveredOutcomes.add(entry.outcomeId);
    const outcome = outcomes.get(entry.outcomeId);
    if (!outcome || entry.outcomeDigest !== outcomeEvidenceDigest(outcome)) add("stale_evidence", path, "The learning outcome changed after this evidence was prepared");
    entry.claimIds.forEach((id) => checkClaim(id, path, entry.outcomeId));
  });
  for (const id of outcomes.keys()) if (!coveredOutcomes.has(id)) add("uncovered_outcome", ["outcomeEvidence"], "Every learning outcome needs a researched justification");

  const estimatedModules = new Set<string>();
  evidence.moduleEstimates.forEach((estimate, index) => {
    const path = ["moduleEstimates", index];
    if (estimatedModules.has(estimate.moduleId)) add("duplicate_reference", path, "A module has one estimated range");
    estimatedModules.add(estimate.moduleId);
    const outline = modules.get(estimate.moduleId);
    if (!outline || estimate.moduleDigest !== moduleEvidenceDigest(outline)) add("stale_evidence", path, "The module changed after its estimate was prepared");
    else if (outline.estimatedStudyMinutes < estimate.minMinutes || outline.estimatedStudyMinutes > estimate.maxMinutes) {
      add("invalid_estimate", path, "The displayed estimate must fall within its researched range");
    }
  });
  for (const id of modules.keys()) if (!estimatedModules.has(id)) add("invalid_estimate", ["moduleEstimates"], "Every module needs an estimated range and its assumptions");

  const answered = new Set<string>();
  evidence.questionAnswers.forEach((answer, index) => {
    const path = ["questionAnswers", index];
    if (answered.has(answer.questionId)) add("duplicate_reference", path, "An answer must have one current verification");
    answered.add(answer.questionId);
    if (answer.questionDigest !== questionDigest({ id: answer.questionId, text: answer.question }) || answer.answerDigest !== answerDigest(answer.answer)
      || (answer.decision === "resolved" && answer.basis === "source_evidence" && answer.claimIds.length === 0)) add("unverified_answer", path, "Answer verification must match the exact question and answer");
    answer.claimIds.forEach((id) => checkClaim(id, path));
    if (answer.decision === "resolved" && draft.unresolvedQuestions.some((question) => question.id === answer.questionId)) {
      add("unverified_answer", path, "A resolved question cannot remain unresolved");
    }
  });
  if (draft.unresolvedQuestions.some((question) => question.blocking)) add("blocking_question", ["unresolvedQuestions"], "Required questions must be resolved before approval");
  return issues;
}

/** Quotes/full source blocks and private research identities never enter the authoring projection. */
export function projectCurriculumEvidence(
  draft: CurriculumDraft, evidence: CurriculumResearchEvidence, facts: CurriculumEvidenceFacts, issues: readonly ResearchValidationIssue[],
): CurriculumEvidencePublic {
  const sources = new Map(facts.sources.map((source) => [source.id, source]));
  const passages = new Map(facts.passages.map((passage) => [passage.id, passage]));
  const claims = new Map(facts.claims.filter((claim) => claim.ownerId === facts.ownerId).map((claim) => [claim.id, claim]));
  const evidenceByOutcome = new Map(evidence.outcomeEvidence.map((entry) => [entry.outcomeId, entry]));
  const status = issues.length === 0 ? "verified" : issues.some((issue) => ["unresolved_conflict", "blocking_question"].includes(issue.code)) ? "blocked" : "needs_research";
  return CurriculumEvidencePublicSchema.parse({
    status, rationale: evidence.rationale,
    sources: draft.sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      return !source || !facts.authorizedSourceIds.has(sourceId) ? [] : [{ sourceId, title: source.title, url: source.finalUrl,
        retrievedAt: source.retrievedAt, publishedAt: source.publishedAt, extractionState: source.extractionState }];
    }),
    outcomes: draft.outcomes.map((outcome) => {
      const entry = evidenceByOutcome.get(outcome.id);
      const linked = entry?.claimIds.flatMap((id) => claims.get(id) ? [claims.get(id)!] : []) ?? [];
      const sourceIds = Array.from(new Set(linked.flatMap((claim) => claim.passageIds.flatMap((id) => {
        const passage = passages.get(id);
        return passage && draft.sourceIds.includes(passage.sourceId) && facts.authorizedSourceIds.has(passage.sourceId) ? [passage.sourceId] : [];
      }))));
      return { outcomeId: outcome.id, rationale: entry?.rationale ?? "This learning outcome needs further research.", sourceIds,
        support: !entry || entry.outcomeDigest !== outcomeEvidenceDigest(outcome) || linked.length === 0 ? "unverified"
          : linked.some((claim) => claim.support === "inferred") ? "inferred" : "direct" };
    }),
    estimates: evidence.moduleEstimates.filter((estimate) => draft.modules.some((module) => module.id === estimate.moduleId && estimate.moduleDigest === moduleEvidenceDigest(module)))
      .map(({ moduleId, minMinutes, maxMinutes, assumptions }) => ({ moduleId, minMinutes, maxMinutes, assumptions })),
    limitations: evidence.limitations,
    answers: evidence.questionAnswers.map(({ questionId, question, answer, decision }) => ({ questionId, question, answer, resolved: decision === "resolved" })),
  });
}
