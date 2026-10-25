import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, type JsonValue } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import type { ModelPort } from "@/server/ai/ports";
import { ProviderFailure } from "@/server/ai/failure";
import { jsonDigest } from "@/server/ai/json";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { RunContext } from "@/server/runs/ports";
import { taskDigest } from "@/server/mechanics/digest";
import { MODULE_REVIEW_INSTRUCTIONS, ModuleReviewSchema, assessModuleReview } from "@/server/course-validation/module-review";
import { loadGenerationStep, verifyStoredModelData } from "./repository";
import { loadStage, modelStage, ModelStageSchema, pureStage, type StageIndex } from "./stages";

export const ModuleReviewCheckpointSchema = z.object({ kind: z.literal("course.module.review"), moduleDigest: DigestSchema,
  materialDigest: DigestSchema, pages: z.array(z.object({ outcomeId: IdSchema, stepId: IdSchema }).strict()).min(1), review: ModuleReviewSchema }).strict();
const identitySchema = z.object({ moduleDigest: DigestSchema, approvedOutcomes: z.array(z.object({ id: IdSchema })).min(1) });
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

export async function loadVerifiedModuleReview(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string, material: JsonValue) {
  const step = await loadGenerationStep(tx, binding, stepId, ModuleReviewCheckpointSchema), saved = step.result, identity = identitySchema.parse(material);
  if (saved.moduleDigest !== identity.moduleDigest || saved.materialDigest !== taskDigest(material) || saved.pages.length !== identity.approvedOutcomes.length ||
      new Set(saved.pages.map((page) => page.outcomeId)).size !== saved.pages.length || new Set(saved.pages.map((page) => page.stepId)).size !== saved.pages.length) return invalid();
  const checks: z.infer<typeof ModuleReviewSchema>["checks"] = [];
  for (const page of saved.pages) {
    if (!identity.approvedOutcomes.some((outcome) => outcome.id === page.outcomeId)) return invalid();
    const producer = await loadGenerationStep(tx, binding, page.stepId, ModelStageSchema), review = ModuleReviewSchema.parse(producer.result.data);
    if (producer.inputDigest !== jsonDigest(material)) return invalid();
    await verifyStoredModelData(tx, producer, producer.result.operationId, ModuleReviewSchema, review);
    assessModuleReview(review, material, [page.outcomeId]);
    checks.push(...review.checks);
  }
  const review = { moduleDigest: identity.moduleDigest, checks };
  if (taskDigest(review) !== taskDigest(saved.review)) return invalid();
  return { stepId: step.id, ...assessModuleReview(review, material) };
}

/** Review output grows by saved outcome pages; every page sees the full module's actual context and evidence. */
export async function advanceModuleReview(input: { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex; key: string;
  material: JsonValue; model: ModelPort }): Promise<{ stepId: string; passed: boolean; review: z.infer<typeof ModuleReviewSchema> } | null> {
  const { context, binding, index, material } = input, identity = identitySchema.parse(material);
  const saved = await loadStage(context, binding, index, input.key, ModuleReviewCheckpointSchema);
  if (saved) return context.read((tx) => loadVerifiedModuleReview(tx, binding, saved.id, material));
  const pages: z.infer<typeof ModuleReviewCheckpointSchema>["pages"] = [], checks: z.infer<typeof ModuleReviewSchema>["checks"] = [];
  for (const outcome of identity.approvedOutcomes) {
    const key = `${input.key}/${outcome.id}`, page = await loadStage(context, binding, index, key, ModelStageSchema);
    if (!page) {
      await modelStage({ context, binding, model: input.model, key, purpose: "content_review", schema: ModuleReviewSchema, material,
        instructions: `${MODULE_REVIEW_INSTRUCTIONS} This saved review page covers ONLY outcome ${outcome.id}; return all seven categories exactly once for that outcome. The other approved outcomes and all module content remain context for prerequisite, coherence and transfer checks. Other outcome pages are reviewed separately; never shorten the course to fit this response. Evidence should point to the smallest actual value that supports the finding.` });
      return null;
    }
    const reviewed = assessModuleReview(page.result.data, material, [outcome.id]);
    pages.push({ outcomeId: outcome.id, stepId: page.id }); checks.push(...reviewed.review.checks);
  }
  const review = { moduleDigest: identity.moduleDigest, checks };
  assessModuleReview(review, material);
  await pureStage({ context, binding, key: input.key, material: { moduleDigest: identity.moduleDigest, materialDigest: taskDigest(material), pages }, schema: ModuleReviewCheckpointSchema,
    async commit(tx) {
      for (const page of pages) {
        const producer = await loadGenerationStep(tx, binding, page.stepId, ModelStageSchema), actual = ModuleReviewSchema.parse(producer.result.data);
        if (producer.inputDigest !== jsonDigest(material)) return invalid();
        await verifyStoredModelData(tx, producer, producer.result.operationId, ModuleReviewSchema, actual);
        assessModuleReview(actual, material, [page.outcomeId]);
      }
      return { kind: "course.module.review" as const, moduleDigest: identity.moduleDigest, materialDigest: taskDigest(material), pages, review };
    } });
  return null;
}
