import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { inspectCandidateSourceGrounding, projectCanonicalResearchSources } from "@/server/course-validation/source-grounding";
import { fixture, id } from "./fixtures";

function investigationFixture() {
  const data = fixture(), sources = projectCanonicalResearchSources(data.context).sources, authored = data.authored[0]!.tasks[0]!;
  const rubric = { id: id(900), dimensions: [{ id: "source_scope", criterion: "Infer only the supported scope.", met: "Evidence supports the stated scope.", partial: "A limitation is missing.", notMet: "The claim exceeds the evidence." }] };
  const task = { ...authored.task, mechanicId: "source_investigation", config: { kind: "source_investigation", claim: "The stated affine relationship is supported by the quoted source.", sources } };
  const privateTask = { ...authored.privateTask, evaluationSpec: { kind: "rubric", rubricId: rubric.id, requiredDimensions: ["source_scope"], calibrationSetId: null }, evaluatorData: { sources, rubric },
    assessment: { ...authored.privateTask.assessment, outcomes: [{ outcomeId: task.outcomeIds[0]!, dimensions: [{ dimensionId: "affine_rule", evaluationDimensionIds: ["source_scope"] }] }] } };
  return { data, task, privateTask, candidate: prepareTaskCandidate({ task, privateTask }, { approvalDigest: data.context.approvalDigest }) };
}
describe("canonical source evidence crosses authoring and readiness unchanged", () => {
  it("supplies all required source metadata and exact passage snapshots", () => {
    const { data, candidate } = investigationFixture(), projection = projectCanonicalResearchSources(data.context);
    expect(projection.sources[0]).toEqual({ id: data.source.id, url: data.source.finalUrl, title: data.source.title, retrievedAt: data.source.retrievedAt,
      contentDigest: data.source.contentDigest, passages: [{ id: data.passage.id, text: data.passage.quote }] });
    expect(inspectCandidateSourceGrounding(candidate, data.context).issues).toEqual([]);
  });
  it("returns repairable findings when public and private snapshots agree on invented metadata", () => {
    const { data, task, privateTask } = investigationFixture();
    const changedSources = structuredClone(task.config.sources); changedSources[0]!.title = "An invented but schema-valid title";
    const candidate = prepareTaskCandidate({ task: { ...task, config: { ...task.config, sources: changedSources } },
      privateTask: { ...privateTask, evaluatorData: { ...privateTask.evaluatorData, sources: changedSources } } }, { approvalDigest: data.context.approvalDigest });
    expect(inspectCandidateSourceGrounding(candidate, data.context).issues.some((issue) => issue.includes("canonical stored source"))).toBe(true);
  });
  it("does not truncate oversized quotations into counterfeit canonical evidence", () => {
    const { data, candidate } = investigationFixture(); data.passage.quote = "x".repeat(4001);
    expect(projectCanonicalResearchSources(data.context).unavailableSourceIds).toEqual([data.source.id]);
    expect(inspectCandidateSourceGrounding(candidate, data.context).issues.length).toBeGreaterThan(0);
  });
});
