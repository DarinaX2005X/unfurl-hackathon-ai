import type { CurriculumDraft } from "@/domain/course";
import type { AuthoredModule, ModuleKnowledge, OutcomeCoverage, PreparedModule } from "@/server/course-generation/contracts";
import type { SourceClaim } from "@/server/curriculum-research/contracts";
import type { SourceDocument, Passage } from "@/server/research/ports";
import type { KnowledgeContext } from "@/server/course-validation/knowledge";
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { jsonDigest } from "@/server/ai/json";
import { taskDigest } from "@/server/mechanics/digest";

/** Synthetic contract material only; never a generated course or catalog fixture. */
export const id = (value: number) => `30000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
export const digest = "a".repeat(64), now = "2026-10-25T12:00:00.000Z";
export const privateMarker = "PRIVATE_WORKED_EXAMPLE_SENTINEL";
export function fixture(count = 1) {
  const draft: CurriculumDraft = { id: id(1), courseId: id(2), conversationId: id(3), revision: 1,
    title: "Contract fixture", contentLanguage: "en", goal: "Infer an affine relationship from observations and apply it to new inputs.",
    audience: "Learners who can perform arithmetic", assumedKnowledge: ["Arithmetic"], unresolvedQuestions: [],
    outcomes: [], modules: [], sourceIds: [id(4)], updatedAt: now };
  const source: SourceDocument = { id: id(4), requestedUrl: "https://example.edu/affine", finalUrl: "https://example.edu/affine",
    title: "Synthetic source", retrievedAt: now, publishedAt: null, mediaType: "text/plain", rawDigest: "b".repeat(64), extractorVersion: "synthetic-contract-v1",
    blocks: [{ id: "b1", text: "An affine function has the form y = ax + b. Distinct input observations determine its slope and intercept." }],
    extractionState: "complete", contentDigest: "" };
  source.contentDigest = jsonDigest(source.blocks, 2 * 1024 * 1024);
  const passage: Passage = { id: id(5), sourceId: source.id, blockId: "b1", start: 0, end: source.blocks[0]!.text.length, quote: source.blocks[0]!.text };
  const claims: SourceClaim[] = [], knowledge: ModuleKnowledge[] = [], authored: AuthoredModule[] = [], coverage: OutcomeCoverage[] = [];
  for (let index = 0; index < count; index++) {
    const n = 100 + index * 100, outcomeId = id(n), moduleId = id(n + 1), lessonId = id(n + 2), claimId = id(n + 3), blockId = id(n + 4);
    draft.outcomes.push({ id: outcomeId, title: `Apply affine relationship ${index + 1}`, demonstration: "Infer a relationship and apply it in a new scenario.", prerequisiteOutcomeIds: index ? [id(n - 100)] : [], requirement: index ? "specialization" : "core" });
    draft.modules.push({ id: moduleId, title: `Module ${index + 1}`, summary: "Use observations to infer a relationship.", outcomeIds: [outcomeId], prerequisiteModuleIds: index ? [id(n - 99)] : [], estimatedStudyMinutes: 40 });
    claims.push({ id: claimId, ownerId: id(6), runStepId: id(7), text: "An affine function can be inferred from distinct input observations.", passageIds: [passage.id], outcomeIds: [outcomeId], scope: { subject: "Affine functions", version: null }, support: "direct", unresolvedConflicts: [], createdAt: now });
    knowledge.push({ schemaVersion: 1, moduleId, approvalDigest: digest, outcomes: [{ outcomeId, learnerAction: "Infer and apply a relationship.", criteria: [{ id: "affine_rule", description: "Infer slope and intercept and correctly predict unseen inputs." }], concepts: [{ explanation: "An affine function has a fixed slope and intercept.", claimIds: [claimId] }], misconceptions: [{ belief: "One pair always determines the slope.", correction: "Use two distinct inputs and check consistency with the remaining observations.", claimIds: [claimId] }] }], limitations: [] });
    const tasks: AuthoredModule["tasks"] = [0, 1].map((offset) => {
      const taskId = id(n + 10 + offset), slope = offset + 2;
      return { task: { id: taskId, taskVersion: 1, mechanicId: "rule_induction", mechanicVersion: 2, responseSchemaVersion: 2, outcomeIds: [outcomeId], instruction: offset ? "Infer the pricing relationship for a new transport service and predict its next quote." : "Infer the input-output relationship and predict a new output.", contentLanguage: "en", availableHints: 1,
        config: { kind: "rule_induction", pairs: [[0, 1], [1, slope + 1], [2, slope * 2 + 1]], hypothesisClass: "affine", probeXs: [3] } },
      privateTask: { taskId, taskVersion: 1, evaluationSpec: { kind: "deterministic", evaluatorId: "rule_induction", evaluatorVersion: 2, secretConfig: null }, evaluatorData: { tolerance: { absTol: 1e-8, relTol: 1e-8 } }, assessment: { evidenceGroupId: id(n + 20 + offset), role: "required", outcomes: [{ outcomeId, dimensions: [{ dimensionId: "affine_rule", evaluationDimensionIds: ["slope", "intercept", "new_inputs"] }] }] }, sourceClaimIds: [claimId], hints: ["Compare the change in outputs with the change in inputs."], workedExample: privateMarker },
      design: { taskId, learnerAction: "Infer and apply a relationship.", mechanicRationale: "The numeric rule and probe predictions require the intended action.", affordances: ["numeric_rule", "probe_predictions"], purpose: offset ? "demonstration" : "practice", transfer: offset ? { fromTaskIds: [id(n + 10)], changedContext: "New transport pricing observations with different slope.", independentDemand: "Infer without seeing the practiced coefficients." } : null } };
    });
    authored.push({ schemaVersion: 1, moduleId, approvalDigest: digest,
      lessons: [{ id: lessonId, courseVersionId: id(8), moduleId, title: "Infer a relationship", outcomeIds: [outcomeId], blocks: [{ id: blockId, kind: "explanation", markdown: "Compare changes to infer the slope, then solve for the intercept.", sourceIds: [source.id] }, ...tasks.map((entry, offset) => ({ id: id(n + 30 + offset), kind: "task" as const, taskId: entry.task.id }))], taskIds: tasks.map((entry) => entry.task.id) }], tasks,
      readingEvidence: [{ lessonId, blockId, outcomeIds: [outcomeId], claimIds: [claimId] }] });
    coverage.push({ outcomeId, introducedAt: [{ lessonId, blockId }], practicedTaskIds: [tasks[0]!.task.id], demonstratedTaskIds: [tasks[1]!.task.id] });
  }
  const context: KnowledgeContext & { courseVersionId: string } = { draft, approvalDigest: digest, courseVersionId: id(8), ownerId: id(6), authorizedSourceIds: new Set([source.id]), sources: [source], passages: [passage], claims };
  return { draft, source, passage, claims, knowledge, authored, coverage, context };
}
export function preparedFixture(count = 1) {
  const data = fixture(count);
  const modules = data.authored.map((section, index) => {
    const result = prepareModuleCandidate(section, { ...data.context, knowledge: data.knowledge[index] });
    if (!result.candidate) throw new Error(JSON.stringify(result.issues));
    return result.candidate;
  });
  return { ...data, modules, coverageInput: { ...data.context, modules, coverage: data.coverage } };
}
export function rehash(section: PreparedModule) {
  const { moduleDigest: _digest, ...content } = section;
  void _digest;
  section.moduleDigest = taskDigest(content);
}

export function adaptiveFixture(count = 1) {
  const data = fixture(count);
  data.authored.forEach((section, sectionIndex) => {
    for (const [index, role] of (["practice", "diagnostic", "challenge"] as const).entries()) {
      const authored = structuredClone(section.tasks[0]!), taskId = id(1000 + sectionIndex * 100 + index), slope = 5 + index;
      authored.task.id = taskId; authored.task.instruction = `Synthetic ${role} activity in a distinct context ${sectionIndex}:${index}.`;
      authored.task.config = { kind: "rule_induction", pairs: [[0, 2], [1, slope + 2], [2, slope * 2 + 2]], hypothesisClass: "affine", probeXs: [4] };
      authored.privateTask.taskId = taskId; authored.privateTask.assessment.role = role; authored.privateTask.assessment.evidenceGroupId = id(2000 + sectionIndex * 100 + index);
      authored.design = { ...authored.design, taskId, purpose: "support", transfer: null };
      section.tasks.push(authored); section.lessons[0]!.taskIds.push(taskId);
      section.lessons[0]!.blocks.push({ id: id(3000 + sectionIndex * 100 + index), kind: "task", taskId });
    }
  });
  const modules = data.authored.map((section, index) => {
    const result = prepareModuleCandidate(section, { ...data.context, knowledge: data.knowledge[index] });
    if (!result.candidate) throw new Error(JSON.stringify(result.issues)); return result.candidate;
  });
  return { ...data, modules };
}
