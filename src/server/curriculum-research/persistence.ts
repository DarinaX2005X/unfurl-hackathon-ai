import "server-only";
import type { DbTransaction } from "../db";
import { curriculumDigest, type CurriculumDraft } from "../../domain/course";
import { jsonDigest } from "../ai/json";
import type { CurriculumResearchEvidence } from "./contracts";
import { validateCurriculumEvidence, type CurriculumEvidenceFacts } from "./validation";
import { PostgresResearchRepository } from "../research/repository";
import { PostgresCurriculumResearchRepository } from "./repository";
import type { PreparedCurriculumOutput } from "./composer";
import { cancelAffectedBuilds, curriculumConflict, mutationResult, requireDraft, researchRequired, saveDraftRevision } from "../curricula/repository";

/** Ignores transport timestamps and newly allocated evidence IDs; captures substantive grounding. */
export function researchFingerprint(evidence: CurriculumResearchEvidence, facts: CurriculumEvidenceFacts): string {
  const sources = new Map(facts.sources.map((source) => [source.id, source]));
  const passages = new Map(facts.passages.map((passage) => [passage.id, passage]));
  const claims = new Map(facts.claims.map((claim) => [claim.id, {
    text: claim.text, scope: claim.scope, support: claim.support, outcomeIds: claim.outcomeIds,
    unresolvedConflicts: claim.unresolvedConflicts.map((conflict) => ({ description: conflict.description, blocking: conflict.blocking })),
    passages: claim.passageIds.map((id) => { const passage = passages.get(id); return passage ? {
      url: sources.get(passage.sourceId)?.finalUrl ?? null, quote: passage.quote,
    } : null; }),
  }]));
  return jsonDigest({ rationale: evidence.rationale, briefDigest: evidence.briefDigest,
    outcomes: evidence.outcomeEvidence.map((entry) => ({ outcomeId: entry.outcomeId, outcomeDigest: entry.outcomeDigest,
      rationale: entry.rationale, claims: entry.claimIds.map((id) => claims.get(id) ?? null) })),
    estimates: evidence.moduleEstimates, limitations: evidence.limitations,
    answers: evidence.questionAnswers.map((answer) => ({ questionId: answer.questionId, question: answer.question, answer: answer.answer,
      decision: answer.decision, basis: answer.basis, rationale: answer.rationale, claims: answer.claimIds.map((id) => claims.get(id) ?? null) })),
  }, 2 * 1024 * 1024);
}

export async function persistPreparedResearch(tx: DbTransaction, prepared: PreparedCurriculumOutput, facts: CurriculumEvidenceFacts): Promise<void> {
  const sourceRepository = new PostgresResearchRepository();
  const repository = new PostgresCurriculumResearchRepository();
  const passageIds = new Map<string, string>();
  for (const passage of prepared.passages) {
    if (!facts.authorizedSourceIds.has(passage.sourceId)) throw researchRequired(prepared.draft.revision);
    passageIds.set(passage.id, (await sourceRepository.savePassage(tx, passage)).id);
  }
  for (const claim of prepared.claims) {
    if (claim.ownerId !== facts.ownerId) throw researchRequired(prepared.draft.revision);
    await repository.saveClaim(tx, { ...claim, passageIds: claim.passageIds.map((id) => passageIds.get(id) ?? id) }, facts.authorizedSourceIds);
  }
}

export async function commitResearchedRevision(tx: DbTransaction, input: {
  ownerId: string; expectedRevision: number; expectedCourseRevision?: number; prepared: PreparedCurriculumOutput;
  facts: CurriculumEvidenceFacts; now: string;
}) {
  const { course, draft: current } = await requireDraft(tx, input.ownerId, input.prepared.draft.id, true);
  if (current.revision !== input.expectedRevision || (input.expectedCourseRevision !== undefined && course.revision !== input.expectedCourseRevision)) throw curriculumConflict(current.revision);
  if (current.courseId !== input.prepared.draft.courseId || current.conversationId !== input.prepared.draft.conversationId || input.facts.ownerId !== input.ownerId) throw researchRequired(current.revision);
  let next: CurriculumDraft = { ...input.prepared.draft, revision: current.revision, updatedAt: current.updatedAt };
  const evidence = structuredClone(input.prepared.evidence);
  const repository = new PostgresCurriculumResearchRepository();
  const previous = await repository.loadEvidence(tx, { draft: current, ownerId: input.ownerId, allowPrevious: true });
  evidence.questionAnswers = [...previous.evidence.questionAnswers.filter((answer) => !evidence.questionAnswers.some((entry) => entry.questionId === answer.questionId)), ...evidence.questionAnswers];
  // Keep previous answer claims available for the exact retained proof references.
  const facts: CurriculumEvidenceFacts = { ...input.facts,
    sources: Array.from(new Map([...previous.facts.sources, ...input.facts.sources].map((source) => [source.id, source])).values()),
    passages: Array.from(new Map([...previous.facts.passages, ...input.facts.passages].map((passage) => [passage.id, passage])).values()),
    claims: Array.from(new Map([...previous.facts.claims, ...input.facts.claims].map((claim) => [claim.id, claim])).values()),
    authorizedSourceIds: new Set([...previous.facts.authorizedSourceIds, ...input.facts.authorizedSourceIds]),
  };
  const answerClaimIds = new Set(evidence.questionAnswers.flatMap((answer) => answer.claimIds));
  const answerPassageIds = new Set(facts.claims.filter((claim) => answerClaimIds.has(claim.id)).flatMap((claim) => claim.passageIds));
  next.sourceIds = Array.from(new Set([...next.sourceIds, ...facts.passages.filter((passage) => answerPassageIds.has(passage.id)).map((passage) => passage.sourceId)]));
  evidence.contentDigest = await curriculumDigest(next);
  const issues = await validateCurriculumEvidence(next, evidence, facts);
  if (issues.some((issue) => !["blocking_question", "unresolved_conflict"].includes(issue.code))) throw researchRequired(current.revision);
  const currentEvidenceExists = (await tx.query("SELECT draft_id FROM unfurl.curriculum_revision_evidence WHERE draft_id=$1 AND revision=$2", [current.id, current.revision])).rowCount === 1;
  const contentChanged = await curriculumDigest(current) !== evidence.contentDigest;
  const groundingChanged = researchFingerprint(previous.evidence, previous.facts) !== researchFingerprint(evidence, facts);
  const onlySourceIdentityChanged = contentChanged && await curriculumDigest({ ...next, sourceIds: current.sourceIds }) === await curriculumDigest(current);
  if (currentEvidenceExists && onlySourceIdentityChanged && !groundingChanged) return mutationResult(tx, input.ownerId, current.courseId);
  if (!contentChanged && !groundingChanged && currentEvidenceExists) return mutationResult(tx, input.ownerId, current.courseId);
  const prepared = { ...input.prepared, draft: next, evidence };
  await persistPreparedResearch(tx, prepared, facts);
  if (contentChanged || currentEvidenceExists) {
    next = { ...next, revision: current.revision + 1, updatedAt: input.now };
    await saveDraftRevision(tx, { ownerId: input.ownerId, previous: current, next, evidence, approvalReady: issues.length === 0 });
  } else {
    // An edited draft can receive its first complete research proof without rewriting that proof later.
    await cancelAffectedBuilds(tx, input.ownerId, current);
    await repository.saveEvidence(tx, { draftId: current.id, revision: current.revision, evidence });
    await tx.query("UPDATE unfurl.curriculum_drafts SET approval_requested_revision=$2 WHERE id=$1", [current.id, issues.length === 0 ? current.revision : null]);
    await tx.query("UPDATE unfurl.courses SET revision=revision+1,updated_at=$3 WHERE id=$1 AND owner_id=$2", [current.courseId, input.ownerId, input.now]);
  }
  return mutationResult(tx, input.ownerId, current.courseId);
}
