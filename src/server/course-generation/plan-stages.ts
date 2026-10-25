import "server-only";
import { z } from "zod";
import { IdSchema, JsonValueSchema, type JsonValue } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import type { ModelPort } from "@/server/ai/ports";
import { jsonDigest } from "@/server/ai/json";
import { ProviderFailure } from "@/server/ai/failure";
import type { ApprovedBuildBinding } from "@/server/curricula/build-binding";
import type { RunContext } from "@/server/runs/ports";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { getCapabilityCatalogDigest, getGenerationMechanicCatalog } from "@/server/mechanics/catalog";
import { taskDigest } from "@/server/mechanics/digest";
import { ModulePlanSchema, type ModulePlan } from "./planning";
import { OutcomeCoverageSchema, type ModuleKnowledge } from "./contracts";
import { loadGenerationStep, verifyStoredModelData } from "./repository";
import { loadStage, mappedModelStage, pureStage, type StageIndex } from "./stages";

export const ModulePlanPageSchema = z.object({ moduleId: IdSchema, outcomeId: IdSchema, part: z.number().int().nonnegative(), complete: z.boolean(),
  lessons: ModulePlanSchema.shape.lessons, tasks: ModulePlanSchema.shape.tasks,
  coverage: z.object({ outcomeId: IdSchema, introducedAt: z.array(OutcomeCoverageSchema.shape.introducedAt.element),
    practicedTaskIds: z.array(IdSchema), demonstratedTaskIds: z.array(IdSchema) }).strict() }).strict();
export type ModulePlanPage = z.infer<typeof ModulePlanPageSchema>;
const PageCheckpointSchema = z.object({ kind: z.literal("course.module.plan.page"), operationId: IdSchema, material: JsonValueSchema, proposal: ModulePlanPageSchema }).strict();
export const ModulePlanCheckpointSchema = z.object({ kind: z.literal("course.module.plan"), moduleId: IdSchema, pageStepIds: z.array(IdSchema).min(1), plan: JsonValueSchema }).strict();
const invalid = (): never => { throw new ProviderFailure("invalid_output"); };

export function orderedModuleOutcomeIds(binding: Pick<ApprovedBuildBinding, "draft">, moduleId: string): string[] {
  const outline = binding.draft.modules.find((section) => section.id === moduleId); if (!outline) return invalid();
  const pending = [...outline.outcomeIds], ordered: string[] = [];
  while (pending.length) {
    const index = pending.findIndex((id) => binding.draft.outcomes.find((outcome) => outcome.id === id)?.prerequisiteOutcomeIds.every((dependency) => !pending.includes(dependency)));
    if (index < 0) return invalid(); ordered.push(pending.splice(index, 1)[0]!);
  }
  return ordered;
}
/** Partial coverage is retained while planning; the existing full-plan validator is the final completeness gate. */
export function assembleModulePlanPages(moduleId: string, pages: readonly ModulePlanPage[]): ModulePlan {
  const coverage = new Map<string, ModulePlan["coverage"][number]>();
  for (const page of pages) {
    if (page.moduleId !== moduleId || page.coverage.outcomeId !== page.outcomeId || page.lessons.some((lesson) => !lesson.outcomeIds.includes(page.outcomeId)) || page.tasks.some((task) => !task.outcomeIds.includes(page.outcomeId))) return invalid();
    const prior = coverage.get(page.outcomeId);
    if (prior) { prior.introducedAt.push(...page.coverage.introducedAt); prior.practicedTaskIds.push(...page.coverage.practicedTaskIds); prior.demonstratedTaskIds.push(...page.coverage.demonstratedTaskIds); }
    else coverage.set(page.outcomeId, { outcomeId: page.outcomeId, introducedAt: [...page.coverage.introducedAt], practicedTaskIds: [...page.coverage.practicedTaskIds], demonstratedTaskIds: [...page.coverage.demonstratedTaskIds] });
  }
  return { moduleId, lessons: pages.flatMap((page) => page.lessons), tasks: pages.flatMap((page) => page.tasks), coverage: [...coverage.values()] };
}
function validatePageScope(page: ModulePlanPage, moduleId: string, outcomeId: string, part: number) {
  if (page.moduleId !== moduleId || page.outcomeId !== outcomeId || page.coverage.outcomeId !== outcomeId || page.part !== part) return invalid();
  assembleModulePlanPages(moduleId, [page]);
}
function verifyPageMaterial(material: JsonValue, binding: ApprovedBuildBinding, knowledge: ModuleKnowledge, page: ModulePlanPage, prior: ModulePlanPage[]) {
  const input = z.object({ module: JsonValueSchema, approvedOutcomes: JsonValueSchema, knowledge: JsonValueSchema,
    catalog: z.object({ capabilityCatalogDigest: z.string() }).passthrough(), scope: z.object({ outcomeId: IdSchema, part: z.number() }), previousPlan: JsonValueSchema }).parse(material);
  if (taskDigest(input.module) !== taskDigest(binding.draft.modules.find((section) => section.id === page.moduleId)) || taskDigest(input.approvedOutcomes) !== taskDigest(binding.draft.outcomes) ||
      taskDigest(input.knowledge) !== taskDigest(knowledge) || input.catalog.capabilityCatalogDigest !== getCapabilityCatalogDigest() || input.scope.outcomeId !== page.outcomeId || input.scope.part !== page.part ||
      taskDigest(input.previousPlan) !== taskDigest(assembleModulePlanPages(page.moduleId, prior))) return invalid();
}
export async function loadVerifiedModulePlan(tx: DbTransaction, binding: ApprovedBuildBinding, stepId: string, knowledge: ModuleKnowledge) {
  const saved = await loadGenerationStep(tx, binding, stepId, ModulePlanCheckpointSchema), moduleId = knowledge.moduleId;
  if (saved.result.moduleId !== moduleId || new Set(saved.result.pageStepIds).size !== saved.result.pageStepIds.length) return invalid();
  const ordered = orderedModuleOutcomeIds(binding, moduleId), pages: ModulePlanPage[] = [];
  let outcomeIndex = 0, part = 0;
  for (const id of saved.result.pageStepIds) {
    const producer = await loadGenerationStep(tx, binding, id, PageCheckpointSchema), page = producer.result.proposal;
    validatePageScope(page, moduleId, ordered[outcomeIndex] ?? invalid(), part);
    verifyPageMaterial(producer.result.material, binding, knowledge, page, pages);
    if (producer.inputDigest !== jsonDigest(producer.result.material)) return invalid();
    await verifyStoredModelData(tx, producer, producer.result.operationId, ModulePlanPageSchema, page);
    pages.push(page); if (page.complete) { outcomeIndex++; part = 0; } else part++;
  }
  if (outcomeIndex !== ordered.length || part !== 0) return invalid();
  const plan = assembleModulePlanPages(moduleId, pages);
  if (taskDigest(plan) !== taskDigest(saved.result.plan)) return invalid();
  return { stepId: saved.id, plan };
}

const INSTRUCTIONS = "Plan the next coherent lesson or small group of lessons for the selected approved outcome. Preserve exact moduleId, outcomeId, part and canonical criteria. Each page creates new complete lessons/blocks/tasks with globally unique UUIDs, and may reference earlier planned tasks for transfer. Every new lesson and task must include this page's outcome; integrated work may also assess other approved module outcomes where meaningful. Return this page's contribution to the selected outcome's coverage, with empty reference arrays where this page adds none. Set complete=true only after all required reading, practice, distinct independent transfer and optional practice/diagnostic/challenge opportunities for every criterion are planned across this outcome's saved pages; otherwise set complete=false for another page. There is no total module/course task or metadata length cap: never remove outcomes or simplify demand to fit one response. Required normal-route tasks must use assessmentRole=required; optional roles remain practice, diagnostic or challenge and cannot substitute for required coverage. A lesson with only optional tasks must include substantive grounded reading for its normal-route position. Optional practice addresses learning gaps, diagnostics distinguish misconceptions, and challenges add deeper independent application; avoid cosmetic task variants. Required irreversible outcome_prediction criteria need a genuinely fresh optional assessment, preferably revisable. Choose available mechanics by actual learner action and affordances, not by cycling through a list. Keep prerequisite and transfer order. Prefer planning required tasks before their optional extensions so later authoring can compare contexts.";
export async function advanceModulePlan(input: { context: RunContext; binding: ApprovedBuildBinding; index: StageIndex; key: string; knowledge: ModuleKnowledge;
  runtime: MechanicRuntimeCapabilities; correction: unknown; priorModules: unknown; model: ModelPort }): Promise<{ stepId: string; plan: ModulePlan } | null> {
  const { context, binding, index, knowledge } = input, moduleId = knowledge.moduleId;
  const saved = await loadStage(context, binding, index, input.key, ModulePlanCheckpointSchema);
  if (saved) return context.read((tx) => loadVerifiedModulePlan(tx, binding, saved.id, knowledge));
  const pages: ModulePlanPage[] = [], pageStepIds: string[] = [];
  for (const outcomeId of orderedModuleOutcomeIds(binding, moduleId)) {
    let part = 0, complete = false;
    while (!complete) {
      const key = `${input.key}/${outcomeId}/${part}`, existing = await loadStage(context, binding, index, key, PageCheckpointSchema);
      if (!existing) {
        const material = JsonValueSchema.parse({ module: binding.draft.modules.find((section) => section.id === moduleId), approvedOutcomes: binding.draft.outcomes,
          knowledge, contentLanguage: binding.draft.contentLanguage, catalog: getGenerationMechanicCatalog(input.runtime), correction: input.correction, priorModules: input.priorModules,
          scope: { outcomeId, part }, previousPlan: assembleModulePlanPages(moduleId, pages) });
        await mappedModelStage({ context, binding, model: input.model, key, purpose: "task_authoring", schema: ModulePlanPageSchema, resultSchema: PageCheckpointSchema, material, instructions: INSTRUCTIONS,
          async commit(_tx, proposal, operationId) { validatePageScope(proposal, moduleId, outcomeId, part); return { kind: "course.module.plan.page" as const, operationId, material, proposal }; } });
        return null;
      }
      const page = existing.result.proposal; validatePageScope(page, moduleId, outcomeId, part); verifyPageMaterial(existing.result.material, binding, knowledge, page, pages);
      pages.push(page); pageStepIds.push(existing.id); complete = page.complete; part++;
    }
  }
  const plan = assembleModulePlanPages(moduleId, pages);
  await pureStage({ context, binding, key: input.key, material: { moduleId, pageStepIds }, schema: ModulePlanCheckpointSchema,
    async commit(tx) {
      for (const id of pageStepIds) {
        const producer = await loadGenerationStep(tx, binding, id, PageCheckpointSchema);
        if (producer.inputDigest !== jsonDigest(producer.result.material)) return invalid();
        await verifyStoredModelData(tx, producer, producer.result.operationId, ModulePlanPageSchema, producer.result.proposal);
      }
      return { kind: "course.module.plan" as const, moduleId, pageStepIds, plan: JsonValueSchema.parse(plan) };
    } });
  return null;
}
