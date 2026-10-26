import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "@/domain/common";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { ModelPort } from "@/server/ai/ports";
import { ProviderFailure } from "@/server/ai/failure";
import type { RunContext } from "@/server/runs/ports";
import { taskDigest } from "@/server/mechanics/digest";
import { validateModuleKnowledge } from "@/server/course-validation/knowledge";
import { ApprovedKnowledgeProposalSchema, ApprovedModuleKnowledgeCheckpointSchema,
  ApprovedKnowledgeCommentaryResponseSchema, ApprovedKnowledgeNarrationProofSchema } from "./checkpoints";
import { approvedResearchFactsDigest } from "./batch-provenance";
import type { ModuleKnowledge } from "./contracts";
import { GenerationEvidenceRepository, verifyStoredApprovedResearchProposal } from "./repository";
import { loadStage, mappedModelStageV2, mappedPolicyModelStage, type StageIndex } from "./stages";

export const ApprovedResearchGapCheckpointSchema = z.object({
  kind: z.literal("course.module.approved_knowledge_gap"), moduleId: IdSchema, approvalDigest: DigestSchema,
  approvedFactsDigest: DigestSchema, operationId: IdSchema, proposal: ApprovedKnowledgeProposalSchema,
  gaps: z.array(z.string().min(1)).min(1),
  narration: ApprovedKnowledgeNarrationProofSchema.optional(),
}).strict();
export const ApprovedResearchCheckpointSchema = z.union([ApprovedModuleKnowledgeCheckpointSchema, ApprovedResearchGapCheckpointSchema]);
export const approvedKnowledgeKey = (moduleId: string) => `course/${moduleId}/research-v2/approved-knowledge`;

/** A sufficiency claim is only a proposal: exact scope and existing source validators still decide reuse. */
export function prepareApprovedResearchCheckpoint(input: {
  binding: ApprovedBuildBinding; moduleId: string; operationId: string;
  proposal: z.infer<typeof ApprovedKnowledgeProposalSchema>;
  narration?: z.infer<typeof ApprovedKnowledgeNarrationProofSchema>;
}) {
  const { binding, moduleId, operationId } = input;
  if (!binding.draft.modules.some(section => section.id === moduleId)) throw new ProviderFailure("invalid_output");
  const proposal = ApprovedKnowledgeProposalSchema.parse(input.proposal);
  const narration = input.narration && ApprovedKnowledgeNarrationProofSchema.parse(input.narration);
  if (narration && taskDigest(narration.response.proposal) !== taskDigest(proposal)) throw new ProviderFailure("invalid_output");
  const approvedFactsDigest = approvedResearchFactsDigest(binding.facts);
  const gaps: string[] = [];
  if (proposal.status === "needs_research") gaps.push(...proposal.gaps);
  else {
    if (proposal.knowledge.moduleId !== moduleId) gaps.push("Knowledge describes a different module than the approved research request.");
    gaps.push(...validateModuleKnowledge(proposal.knowledge, { ...binding.facts, draft: binding.draft,
      approvalDigest: binding.approval.contentDigest }).map(issue => `${issue.code} at ${issue.path.join(".") || "knowledge"}: ${issue.message}`));
    if (!gaps.length) return ApprovedModuleKnowledgeCheckpointSchema.parse({ kind: "course.module.approved_knowledge",
      knowledge: proposal.knowledge, proposal, operationId, sourceReadStepIds: [], approvedFactsDigest, ...(narration ? { narration } : {}) });
  }
  return ApprovedResearchGapCheckpointSchema.parse({ kind: "course.module.approved_knowledge_gap", moduleId,
    approvalDigest: binding.approval.contentDigest, approvedFactsDigest, operationId, proposal, gaps, ...(narration ? { narration } : {}) });
}

/** V2-only attempt. One new paid synthesis is followed by reuse or the unchanged fresh-research path. */
export async function advanceApprovedModuleResearch(input: {
  context: RunContext; binding: ApprovedBuildBinding; index: StageIndex; moduleId: string;
  model: ModelPort; priorKnowledge: readonly ModuleKnowledge[];
  knowledgeCoveragePolicy?: "approved-scope-v1";
}) {
  const { context, binding, index, moduleId, model } = input;
  const section = binding.draft.modules.find(entry => entry.id === moduleId);
  if (!section) throw new ProviderFailure("invalid_output");
  const key = approvedKnowledgeKey(moduleId);
  const existing = await loadStage(context, binding, index, key, ApprovedResearchCheckpointSchema);
  if (!existing) {
    const outcomes = binding.draft.outcomes.filter(entry => section.outcomeIds.includes(entry.id));
    const claims = binding.facts.claims.filter(claim => claim.outcomeIds.some(id => section.outcomeIds.includes(id)));
    const passageIds = new Set(claims.flatMap(claim => claim.passageIds));
    const passages = binding.facts.passages.filter(passage => passageIds.has(passage.id));
    const sourceIds = new Set(passages.map(passage => passage.sourceId));
    const approvedFactsDigest = approvedResearchFactsDigest(binding.facts);
    const material = { moduleId, approvalDigest: binding.approval.contentDigest, approvedFactsDigest,
        section, outcomes, contentLanguage: binding.draft.contentLanguage, audience: binding.draft.audience,
        assumedKnowledge: binding.draft.assumedKnowledge, claims, passages,
        sources: binding.facts.sources.filter(source => sourceIds.has(source.id)).map(source => ({ sourceId: source.id,
          title: source.title, url: source.finalUrl, contentDigest: source.contentDigest, retrievedAt: source.retrievedAt })),
        limitations: binding.evidence.limitations,
        establishedCriteria: input.priorKnowledge.flatMap(known => known.outcomes.filter(outcome => section.outcomeIds.includes(outcome.outcomeId))
          .map(({ outcomeId, criteria }) => ({ outcomeId, criteria }))) };
    const instructions = "Assess whether the supplied immutable approved research is sufficient to teach this entire approved module at its intended depth. Approval of a curriculum is not proof that its research supports all teaching detail. Use actual claims and exact supporting passages, not source titles, snippets, broad topic similarity or prior knowledge as evidence. If any approved outcome, prerequisite-dependent explanation, learner action, misconception correction or assessment criterion lacks substantive support, return needs_research with concrete gaps. Do not invent claim IDs, sources, quotes or receipt identities. Do not narrow advanced outcomes to introductory proxies merely to avoid further research. Only when the supplied evidence supports every approved outcome, return sufficient with complete grounded ModuleKnowledge: exact moduleId and approvalDigest; exactly the module's approved outcomes; stable canonical criterion IDs and specific demonstrable competence; substantive concepts and relevant misconceptions using only supplied claim IDs linked to the actual outcome. For shared outcomes, reuse established criterion IDs and exact descriptions for the same competence, adding distinct criteria only for genuinely additional approved competence. Preserve source limitations, inferred support and unresolved conflicts; do not turn uncertain evidence into certainty. This proposal does not approve lessons or waive later content, coverage or assessment validation.";
    if (input.knowledgeCoveragePolicy === "approved-scope-v1") await mappedPolicyModelStage({ context, binding, model, key,
      purpose: "module_knowledge", instructionVersion: "course-approved-knowledge-commentary-v1", schema: ApprovedKnowledgeCommentaryResponseSchema,
      resultSchema: ApprovedResearchCheckpointSchema, material,
      instructions: `${instructions}\nReturn that assessment as proposal. Also write publicCommentary: a short natural paragraph to the course creator in the course content language, beginning work on this approved section and explaining the next research or lesson-creation action. Mention uncertainty and additional research when needed. Be concrete about the approved topic, without technical implementation labels. Do not claim to have read any new source, completed any lesson or validated the course; this call only examines previously approved research. Do not reveal task answers, private criteria, quoted source passages or internal IDs.`,
      async commit(tx, response, operationId, stepId) {
        if (approvedResearchFactsDigest(binding.facts) !== approvedFactsDigest) throw new ProviderFailure("invalid_output");
        const result = prepareApprovedResearchCheckpoint({ binding, moduleId, operationId, proposal: response.proposal,
          narration: { kind: "approved-knowledge-commentary-v1", response } });
        await context.emitGeneration(tx, { type: "generation.commentary", text: response.publicCommentary, stepId });
        return result;
      } });
    else await mappedModelStageV2({ context, binding, model, key, purpose: "module_knowledge", schema: ApprovedKnowledgeProposalSchema,
      resultSchema: ApprovedResearchCheckpointSchema, material, instructions,
      async commit(_tx, proposal, operationId) {
        if (approvedResearchFactsDigest(binding.facts) !== approvedFactsDigest) throw new ProviderFailure("invalid_output");
        return prepareApprovedResearchCheckpoint({ binding, moduleId, operationId, proposal });
      } });
    return null;
  }
  if (existing.result.kind === "course.module.approved_knowledge_gap") {
    const gap = existing.result;
    const expected = prepareApprovedResearchCheckpoint({ binding, moduleId, operationId: gap.operationId, proposal: gap.proposal,
      ...(gap.narration ? { narration: gap.narration } : {}) });
    if (taskDigest(expected) !== taskDigest(gap)) throw new ProviderFailure("invalid_output");
    await context.read(tx => verifyStoredApprovedResearchProposal(tx, existing, gap.operationId, gap.proposal, gap.narration));
    return { status: "needs_research" as const };
  }
  const loaded = await context.read(tx => new GenerationEvidenceRepository().loadKnowledge(tx, binding, existing.id));
  if (loaded.knowledge.moduleId !== moduleId) throw new ProviderFailure("invalid_output");
  return { status: "sufficient" as const, loaded };
}
