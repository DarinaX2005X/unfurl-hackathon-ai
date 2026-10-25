import { curriculum, ids, timestamp } from "../domain/fixtures";
import { curriculumDigest } from "../../src/domain/course";
import type { CourseArtifactRef } from "../../src/domain/chat";
import type { SourceDocument, Passage } from "../../src/server/research/ports";
import type { CurriculumResearchEvidence, SourceClaim } from "../../src/server/curriculum-research/contracts";
import { briefEvidenceDigest, moduleEvidenceDigest, outcomeEvidenceDigest, type CurriculumEvidenceFacts } from "../../src/server/curriculum-research/validation";

export { curriculum, ids, timestamp };
export const moreIds = {
  passage: "20000000-0000-4000-8000-000000000001",
  claim: "20000000-0000-4000-8000-000000000002",
  foreignActor: "20000000-0000-4000-8000-000000000003",
  step: "20000000-0000-4000-8000-000000000004",
};
export const now = "2026-10-25T12:00:00.000Z";
export function artifact(): CourseArtifactRef {
  const draft = curriculum();
  return { courseId: draft.courseId, title: draft.title, summary: draft.goal, contentLanguage: draft.contentLanguage,
    revision: 1, curriculum: draft, approval: null, approvalRequestedRevision: 1, readyVersionId: null, updatedAt: timestamp };
}
export async function researchFixture() {
  const draft = curriculum();
  const source: SourceDocument = {
    id: ids.source, requestedUrl: "https://example.edu/generalization", finalUrl: "https://example.edu/generalization",
    title: "Generalization and model capacity", retrievedAt: timestamp, publishedAt: null,
    mediaType: "text/plain", rawDigest: "1".repeat(64), extractorVersion: "fixture@1", contentDigest: "2".repeat(64),
    blocks: [{ id: "b1", text: "Compare held-out error when choosing model capacity." }], extractionState: "complete",
  };
  const passage: Passage = { id: moreIds.passage, sourceId: ids.source, blockId: "b1", start: 0,
    end: source.blocks[0]!.text.length, quote: source.blocks[0]!.text };
  const claim: SourceClaim = { id: moreIds.claim, ownerId: ids.actor, runStepId: moreIds.step,
    text: "Model capacity should be assessed with held-out data.", passageIds: [passage.id], outcomeIds: draft.outcomes.map((item) => item.id),
    scope: { subject: "Generalization", version: null }, support: "direct", unresolvedConflicts: [], createdAt: timestamp };
  const evidence: CurriculumResearchEvidence = {
    schemaVersion: 1, contentDigest: await curriculumDigest(draft), briefDigest: briefEvidenceDigest(draft), rationale: "Learn to distinguish fitted behavior from evidence on unseen data before selecting capacity.",
    outcomeEvidence: draft.outcomes.map((outcome) => ({ outcomeId: outcome.id, outcomeDigest: outcomeEvidenceDigest(outcome), claimIds: [claim.id],
      rationale: "The source motivates comparison with held-out observations." })),
    moduleEstimates: draft.modules.map((module) => ({ moduleId: module.id, moduleDigest: moduleEvidenceDigest(module), minMinutes: 20, maxMinutes: 80,
      assumptions: ["Includes reading, practice and reflection; prior algebra is assumed."] })),
    questionAnswers: [], limitations: [],
  };
  const facts: CurriculumEvidenceFacts = { ownerId: ids.actor, authorizedSourceIds: new Set([source.id]), sources: [source], passages: [passage], claims: [claim] };
  return { draft, source, passage, claim, evidence, facts };
}
