import "server-only";
import type { JsonValue } from "@/domain/common";
import { ProviderFailure } from "@/server/ai/failure";
import type { ModelPort } from "@/server/ai/ports";
import type { SearchPolicyId } from "@/server/ai/model-policy";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { ResearchPort } from "@/server/research/ports";
import type { RunContext, StepEffectContext } from "@/server/runs/ports";
import { assessKnowledgeCoverageReview, createKnowledgeCoverageInput, KnowledgeCoverageReviewSchema,
  KNOWLEDGE_COVERAGE_INSTRUCTIONS } from "@/server/course-validation/knowledge";
import { CheckedModuleKnowledgeCheckpointSchema, KnowledgeCoverageCheckpointSchema } from "./checkpoints";
import type { ModuleKnowledge } from "./contracts";
import { GenerationEvidenceRepository, loadVerifiedKnowledgeCoverageReview, type LoadedModuleKnowledge } from "./repository";
import { advanceModuleResearch } from "./research-stages";
import { checkpointJson, loadStage, mappedPolicyModelStage, pureStage, type StageIndex } from "./stages";
import { taskDigest } from "@/server/mechanics/digest";

export function checkedKnowledgeMaterial(input: { sourceKnowledgeStepId: string; knowledge: ModuleKnowledge;
  reviewStepIds: string[]; correction: JsonValue }) {
  return { sourceKnowledgeStepId: input.sourceKnowledgeStepId, knowledgeDigest: taskDigest(input.knowledge),
    reviewStepIds: input.reviewStepIds, correction: input.correction };
}

/** One durable effect per advance; each changed knowledge revision must pass a fresh independent review. */
export async function advanceKnowledgeCoverage(input: { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex;
  source: LoadedModuleKnowledge; round: number; correction: unknown; model: ModelPort;
  research: (effect: StepEffectContext,searchPolicy?:SearchPolicyId) => ResearchPort; searchPolicy?:SearchPolicyId; priorKnowledge: readonly ModuleKnowledge[] }): Promise<LoadedModuleKnowledge | null> {
  const { context, binding, index } = input, repository = new GenerationEvidenceRepository();
  const moduleId = input.source.knowledge.moduleId, prefix = `course/${moduleId}/research/coverage-v1/round/${input.round}`;
  const checkedKey = `${prefix}/checked`, correction = checkpointJson(input.correction);
  const saved = await loadStage(context, binding, index, checkedKey, CheckedModuleKnowledgeCheckpointSchema);
  if (saved) return context.read(tx => repository.loadKnowledge(tx, binding, saved.id));
  let source = input.source;
  // Keep successful research revisions when a later complete-module review requires a new round.
  if (input.round > 0) {
    const previous = await loadStage(context, binding, index,
      `course/${moduleId}/research/coverage-v1/round/${input.round - 1}/checked`, CheckedModuleKnowledgeCheckpointSchema);
    if (previous) {
      await context.read(tx => repository.loadKnowledge(tx, binding, previous.id));
      source = await context.read(tx => repository.loadKnowledge(tx, binding, previous.result.sourceKnowledgeStepId));
    }
  }
  if (source.step.result.kind === "course.module.knowledge.checked.v1") throw new ProviderFailure("invalid_output");
  const outcomeIds = binding.draft.modules.find(module => module.id === moduleId)?.outcomeIds;
  if (!outcomeIds?.length) throw new ProviderFailure("invalid_output");
  for (let revision = 0; revision <= 2; revision++) {
    const reviews: Awaited<ReturnType<typeof loadVerifiedKnowledgeCoverageReview>>[] = [];
    for (const outcomeId of outcomeIds) {
      const key = `${prefix}/revision/${revision}/review/${outcomeId}`;
      const stored = await loadStage(context, binding, index, key, KnowledgeCoverageCheckpointSchema);
      if (!stored) {
        const material = createKnowledgeCoverageInput({ draft: binding.draft, knowledge: source.knowledge,
          sourceKnowledgeStepId: source.step.id, outcomeId, facts: source.facts, correction });
        await mappedPolicyModelStage({ context, binding, model: input.model, key, purpose: "content_review",
          instructionVersion: "course-knowledge-coverage-v1", schema: KnowledgeCoverageReviewSchema,
          resultSchema: KnowledgeCoverageCheckpointSchema, material, instructions: KNOWLEDGE_COVERAGE_INSTRUCTIONS,
          async commit(tx, review, operationId, stepId) {
            assessKnowledgeCoverageReview(review, material);
            if (outcomeId === outcomeIds[0] && review.publicCommentary) await context.emitGeneration(tx,
              { type: "generation.commentary", text: review.publicCommentary, stepId });
            return { kind: "course.module.knowledge.review.v1" as const, sourceKnowledgeStepId: source.step.id,
              operationId, material, review };
          } });
        return null;
      }
      const reviewed = await context.read(tx => loadVerifiedKnowledgeCoverageReview(tx, binding, stored.id, source, correction));
      if (reviewed.review.outcomeId !== outcomeId) throw new ProviderFailure("invalid_output");
      reviews.push(reviewed);
    }
    if (reviews.every(review => review.passed)) {
      const result = { kind: "course.module.knowledge.checked.v1" as const, knowledge: source.knowledge,
        sourceKnowledgeStepId: source.step.id, sourceReadStepIds: source.step.result.sourceReadStepIds,
        reviewStepIds: reviews.map(review => review.step.id), correction };
      await pureStage({ context, binding, key: checkedKey, material: checkedKnowledgeMaterial(result),
        schema: CheckedModuleKnowledgeCheckpointSchema, async commit(tx) {
          for (const review of reviews) if (!(await loadVerifiedKnowledgeCoverageReview(tx, binding, review.step.id, source, correction)).passed)
            throw new ProviderFailure("invalid_output");
          return result;
        } });
      return null;
    }
    if (revision === 2) throw new ProviderFailure("invalid_output");
    const revised = await advanceModuleResearch({ context, binding, index, moduleId, model: input.model,
      research: input.research, priorKnowledge: input.priorKnowledge,...(input.searchPolicy?{searchPolicy:input.searchPolicy}:{}),
      revision: { prefix: `${prefix}/revision/${revision + 1}`, previous: source,
        reviews: reviews.map(review => ({ stepId: review.step.id, review: review.review })), correction } });
    if (!revised) return null;
    source = revised;
  }
  throw new ProviderFailure("invalid_output");
}
