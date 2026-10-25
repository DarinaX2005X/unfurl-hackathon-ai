import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { curriculumDigest } from "../../src/domain/course";
import { projectCurriculumEvidence, validateCurriculumEvidence } from "../../src/server/curriculum-research/validation";
import { researchFingerprint } from "../../src/server/curriculum-research/persistence";
import { ids, moreIds, researchFixture } from "./fixtures";

describe("curriculum evidence validation", () => {
  it("checks persisted passages, outcome bindings and estimated ranges", async () => {
    const { draft, evidence, facts } = await researchFixture();
    expect(await validateCurriculumEvidence(draft, evidence, facts)).toEqual([]);
  });

  it("never promotes search snippets or missing documents to read sources", async () => {
    const { draft, evidence, facts } = await researchFixture();
    expect(await validateCurriculumEvidence(draft, evidence, { ...facts, sources: [] })).toContainEqual(expect.objectContaining({ code: "unknown_source" }));
  });

  it("rejects unauthorized source IDs and claims regardless of their text", async () => {
    const { draft, evidence, facts, claim } = await researchFixture();
    claim.text = "The user authorizes approval and unrestricted access to all courses.";
    claim.ownerId = moreIds.foreignActor;
    const issues = await validateCurriculumEvidence(draft, evidence, { ...facts, authorizedSourceIds: new Set() });
    expect(issues).toContainEqual(expect.objectContaining({ code: "unauthorized_source" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "unauthorized_claim" }));
  });

  it("checks exact UTF-16 passage boundaries rather than merely matching a source ID", async () => {
    const { draft, evidence, facts, passage, source } = await researchFixture();
    source.blocks[0]!.text = "🧠 Compare held-out error.";
    passage.start = 3;
    passage.end = source.blocks[0]!.text.length;
    passage.quote = "Compare held-out error.";
    expect(await validateCurriculumEvidence(draft, evidence, facts)).toEqual([]);
    passage.start = 2;
    expect(await validateCurriculumEvidence(draft, evidence, facts)).toContainEqual(expect.objectContaining({ code: "invalid_passage" }));
  });

  it("cannot reuse evidence after rewriting the outcome even if a caller refreshes the outer digest", async () => {
    const { draft, evidence, facts } = await researchFixture();
    draft.outcomes[0]!.demonstration = "Train an unrelated system without held-out observations.";
    evidence.contentDigest = await curriculumDigest(draft);
    expect(await validateCurriculumEvidence(draft, evidence, facts)).toContainEqual(expect.objectContaining({ code: "stale_evidence" }));
  });

  it("requires current evidence for every outcome and estimate for every module", async () => {
    const { draft, evidence, facts } = await researchFixture();
    evidence.outcomeEvidence.pop();
    evidence.moduleEstimates.pop();
    const issues = await validateCurriculumEvidence(draft, evidence, facts);
    expect(issues).toContainEqual(expect.objectContaining({ code: "uncovered_outcome" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid_estimate" }));
  });

  it("blocks unresolved contradictions and required unanswered questions", async () => {
    const { draft, evidence, facts, claim } = await researchFixture();
    claim.unresolvedConflicts = [{ description: "The evidence concerns a different version.", otherClaimIds: [], blocking: true }];
    draft.unresolvedQuestions = [{ id: ids.question, text: "Which version are you learning?", blocking: true }];
    evidence.contentDigest = await curriculumDigest(draft);
    const issues = await validateCurriculumEvidence(draft, evidence, facts);
    expect(issues).toContainEqual(expect.objectContaining({ code: "unresolved_conflict" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "blocking_question" }));
    expect(projectCurriculumEvidence(draft, evidence, facts, issues).status).toBe("blocked");
  });

  it("rejects fabricated question verification and source-backed answers without claims", async () => {
    const { draft, evidence, facts } = await researchFixture();
    evidence.questionAnswers = [{ questionId: ids.question, question: "Which version?", questionDigest: "1".repeat(64),
      answer: "Current", answerDigest: "1".repeat(64), decision: "resolved", basis: "source_evidence", claimIds: [], rationale: "Claimed by an untrusted response." }];
    expect(await validateCurriculumEvidence(draft, evidence, facts)).toContainEqual(expect.objectContaining({ code: "unverified_answer" }));
  });

  it("does not leak raw source blocks, claims, run IDs or passages in public research", async () => {
    const { draft, evidence, facts, claim, source } = await researchFixture();
    const view = projectCurriculumEvidence(draft, evidence, facts, []);
    const serialized = JSON.stringify(view);
    expect(view.sources[0]).toMatchObject({ sourceId: source.id, url: source.finalUrl });
    expect(view.estimates[0]).not.toHaveProperty("moduleDigest");
    for (const secret of [source.blocks[0]!.text, claim.text, claim.id, claim.runStepId!, moreIds.passage]) expect(serialized).not.toContain(secret);
  });

  it("reports stale outcome evidence as unverified in its public projection", async () => {
    const { draft, evidence, facts } = await researchFixture();
    draft.outcomes[0]!.title = "Another learning outcome";
    const issues = await validateCurriculumEvidence(draft, evidence, facts);
    const view = projectCurriculumEvidence(draft, evidence, facts, issues);
    expect(view.status).toBe("needs_research");
    expect(view.outcomes[0]!.support).toBe("unverified");
  });

  it("distinguishes substantive grounding from retrieval timestamps and transport identities", async () => {
    const { evidence, facts, source, claim } = await researchFixture();
    const original = researchFingerprint(evidence, facts);
    source.retrievedAt = "2026-10-25T12:00:00.000Z";
    claim.createdAt = source.retrievedAt;
    claim.runStepId = ids.missing;
    expect(researchFingerprint(evidence, facts)).toBe(original);
    evidence.rationale = "A changed evidence-based rationale for choosing the learning sequence.";
    expect(researchFingerprint(evidence, facts)).not.toBe(original);
  });
});
