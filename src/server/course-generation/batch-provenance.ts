import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema, type JsonValue } from "@/domain/common";
import type { CurriculumEvidenceFacts } from "@/server/curriculum-research/validation";
import { ProviderFailure } from "@/server/ai/failure";
import { jsonDigest } from "@/server/ai/json";
import { taskDigest } from "@/server/mechanics/digest";
import { AuthoredTaskSchema, BatchItemProofSchema, BatchKindSchema, type BatchItemProof, type BatchKind } from "./checkpoints";
import { ModulePlanSchema } from "./planning";
import { ModuleKnowledgeSchema } from "./contracts";

export const BatchMaterialSchema = z.object({ batchKind: BatchKindSchema, moduleId: IdSchema, approvalDigest: DigestSchema,
  requestedIds: z.array(IdSchema).min(1).max(5), items: z.array(z.object({ itemId: IdSchema, material: JsonValueSchema,
    candidateStepId: IdSchema.optional(), candidateDigest: DigestSchema.optional() }).passthrough()).min(1).max(5) }).passthrough();
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

export function createBatchItemProof(batchStepId: string, items: readonly { itemId: string; value: unknown }[], itemId: string): BatchItemProof {
  const itemIndex = items.findIndex((item) => item.itemId === itemId);
  if (itemIndex < 0 || new Set(items.map((item) => item.itemId)).size !== items.length) return invalid();
  return BatchItemProofSchema.parse({ kind: "batch-item-v2", batchStepId, itemId, itemIndex, itemDigest: taskDigest(items[itemIndex]!.value) });
}

/** Pure projection checks supplement, never replace, the parent's paid-response verification. */
export function assertBatchItemProjection(input: { proof: BatchItemProof; batchKind: BatchKind; expectedKind: BatchKind;
  material: unknown; items: readonly { itemId: string; value: unknown }[]; childInputDigest: string;
  approvalDigest: string; expected: unknown; candidateStepId?: string | undefined; candidateDigest?: string | undefined }) {
  const proof = BatchItemProofSchema.parse(input.proof), material = BatchMaterialSchema.parse(input.material);
  if (input.batchKind !== input.expectedKind || material.batchKind !== input.expectedKind || material.approvalDigest !== input.approvalDigest ||
      new Set(material.requestedIds).size !== material.requestedIds.length ||
      taskDigest(material.requestedIds) !== taskDigest(input.items.map((item) => item.itemId)) ||
      taskDigest(material.requestedIds) !== taskDigest(material.items.map((item) => item.itemId))) return invalid();
  const item = input.items[proof.itemIndex], request = material.items[proof.itemIndex];
  if (!item || !request || item.itemId !== proof.itemId || request.itemId !== proof.itemId ||
      taskDigest(item.value) !== proof.itemDigest || taskDigest(item.value) !== taskDigest(input.expected) ||
      jsonDigest(request.material) !== input.childInputDigest) return invalid();
  if (input.expectedKind !== "candidate" && (!input.candidateStepId || !input.candidateDigest ||
      request.candidateStepId !== input.candidateStepId || request.candidateDigest !== input.candidateDigest)) return invalid();
  if (input.expectedKind === "candidate") {
    const authored = AuthoredTaskSchema.parse(input.expected);
    const context = z.object({ slot: ModulePlanSchema.shape.tasks.element, knowledge: ModuleKnowledgeSchema,
      approvalDigest: DigestSchema }).parse(request.material), slot = context.slot;
    const mapping = (values: { outcomeId: string; criterionIds: string[] }[]) => values.map(value => ({ outcomeId: value.outcomeId,
      criterionIds: [...value.criterionIds].sort() })).sort((left, right) => left.outcomeId.localeCompare(right.outcomeId));
    if (slot.id !== proof.itemId || authored.task.id !== slot.id || authored.task.taskVersion !== 1 ||
        authored.task.mechanicId !== slot.mechanicId || authored.task.mechanicVersion !== slot.mechanicVersion ||
        taskDigest(authored.task.outcomeIds) !== taskDigest(slot.outcomeIds) || taskDigest(authored.design) !== taskDigest(slot.design) ||
        authored.privateTask.assessment.role !== slot.assessmentRole || context.approvalDigest !== input.approvalDigest ||
        context.knowledge.approvalDigest !== input.approvalDigest || context.knowledge.moduleId !== material.moduleId ||
        taskDigest(mapping(slot.criteria)) !== taskDigest(mapping(authored.privateTask.assessment.outcomes.map(outcome => ({
          outcomeId: outcome.outcomeId, criterionIds: outcome.dimensions.map(dimension => dimension.dimensionId) }))))) return invalid();
  }
  return { material, request, value: item.value };
}

export function approvedResearchFactsDigest(facts: CurriculumEvidenceFacts): string {
  const ordered = <T extends { id: string }>(values: readonly T[]) => [...values].sort((left, right) => left.id.localeCompare(right.id));
  return jsonDigest({ ownerId: facts.ownerId, authorizedSourceIds: [...facts.authorizedSourceIds].sort(),
    sources: ordered(facts.sources), claims: ordered(facts.claims), passages: ordered(facts.passages) } as unknown as JsonValue, 2 * 1024 * 1024);
}
