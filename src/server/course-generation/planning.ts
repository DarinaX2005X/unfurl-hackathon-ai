import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import type { CurriculumDraft } from "@/domain/course";
import { LessonBlockSchema } from "@/domain/learning";
import { MechanicIdSchema } from "@/domain/mechanics";
import { getGenerationMechanicCatalog } from "@/server/mechanics/catalog";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { ReadingEvidenceSchema, OutcomeCoverageSchema, TaskDesignSchema, type ModuleKnowledge, type GenerationValidationIssue } from "./contracts";

const text = z.string().trim().min(1).max(4000), ids = z.array(IdSchema).min(1);
export const ModuleResearchPlanSchema = z.object({
  moduleId: IdSchema,
  queries: z.array(z.object({ key: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), query: z.string().trim().min(1).max(2000),
    domainHints: z.array(z.string().min(1).max(253)), outcomeIds: ids, knowledgeGap: text }).strict()).min(1),
}).strict();
export const SourceSelectionSchema = z.object({
  moduleId: IdSchema, selections: z.array(z.object({ searchStepId: IdSchema, hitId: IdSchema, outcomeIds: ids, reason: text }).strict()).min(1),
  limitations: z.array(text),
}).strict();
const ReadingPlanSchema = z.object({ id: IdSchema, kind: z.enum(["explanation", "example"]),
  outcomeIds: ids, claimIds: ids, teachingPurpose: text, title: text.nullable() }).strict();
export const ModulePlanSchema = z.object({
  moduleId: IdSchema,
  lessons: z.array(z.object({ id: IdSchema, title: z.string().trim().min(1).max(200), outcomeIds: ids,
    blocks: z.array(z.union([ReadingPlanSchema, z.object({ id: IdSchema, kind: z.literal("task"), taskId: IdSchema }).strict()])).min(1),
  }).strict()).min(1),
  tasks: z.array(z.object({ id: IdSchema, lessonId: IdSchema, outcomeIds: ids,
    mechanicId: MechanicIdSchema, mechanicVersion: z.number().int().positive(), design: TaskDesignSchema,
    assessmentRole: z.enum(["required", "practice", "diagnostic", "challenge"]),
    criteria: z.array(z.object({ outcomeId: IdSchema, criterionIds: z.array(z.string().min(1).max(128)).min(1) }).strict()).min(1),
  }).strict()),
  coverage: z.array(OutcomeCoverageSchema),
}).strict();
export type ModulePlan = z.infer<typeof ModulePlanSchema>;
export const LessonReadingSchema = z.object({
  lessonId: IdSchema,
  blocks: z.array(z.union([LessonBlockSchema.options[0], LessonBlockSchema.options[1]])),
  readingEvidence: z.array(ReadingEvidenceSchema),
}).strict();
export type LessonReading = z.infer<typeof LessonReadingSchema>;

/** Plans select genuine learner actions and supported affordances; task counts do not prove depth. */
export function validateModulePlan(value: unknown, input: { draft: CurriculumDraft; knowledge: ModuleKnowledge; runtime: MechanicRuntimeCapabilities }): GenerationValidationIssue[] {
  const parsed = ModulePlanSchema.safeParse(value);
  if (!parsed.success) return [{ code: "invalid_shape", path: [], message: "Module plan must match its strict schema" }];
  const plan = parsed.data, issues: GenerationValidationIssue[] = [];
  const add = (code: GenerationValidationIssue["code"], message: string) => issues.push({ code, path: ["plan"], message });
  const approved = input.draft.modules.find((entry) => entry.id === plan.moduleId);
  if (!approved || plan.moduleId !== input.knowledge.moduleId) return [{ code: "unknown_reference", path: ["moduleId"], message: "Plan must describe the researched approved module" }];
  const catalog = getGenerationMechanicCatalog(input.runtime);
  const lessonIds = new Set(plan.lessons.map((lesson) => lesson.id)), taskIds = new Set(plan.tasks.map((task) => task.id)), blockIds = new Set<string>(), usedTasks = new Set<string>();
  const positions = new Map<string, number>(); let position = 0;
  if (lessonIds.size !== plan.lessons.length || taskIds.size !== plan.tasks.length) add("duplicate_reference", "Lesson/task identities must be unique");
  for (const lesson of plan.lessons) {
    if (new Set(lesson.outcomeIds).size !== lesson.outcomeIds.length || lesson.outcomeIds.some((id) => !approved.outcomeIds.includes(id))) add("unknown_reference", "Lesson outcomes must belong to this approved module");
    for (const block of lesson.blocks) {
      if (blockIds.has(block.id)) add("duplicate_reference", "Block identities must be unique");
      blockIds.add(block.id);
      positions.set(block.kind === "task" ? block.taskId : block.id, position++);
      if (block.kind === "task") {
        const task = plan.tasks.find((entry) => entry.id === block.taskId);
        if (!task || task.lessonId !== lesson.id || usedTasks.has(block.taskId)) add("unknown_reference", "Each task needs exactly one block in its own lesson");
        usedTasks.add(block.taskId);
      } else {
        if (block.outcomeIds.some((id) => !lesson.outcomeIds.includes(id))) add("unknown_reference", "Reading outcomes must belong to its lesson");
        for (const outcomeId of block.outcomeIds) {
          const known = input.knowledge.outcomes.find((outcome) => outcome.outcomeId === outcomeId);
          if (!known || !block.claimIds.some((id) => [...known.concepts, ...known.misconceptions].some((entry) => entry.claimIds.includes(id)))) add("invalid_source", "Each reading outcome needs a claim from researched knowledge");
        }
      }
    }
    if (!lesson.blocks.some((block) => block.kind !== "task") && !plan.tasks.some((task) => task.lessonId === lesson.id && task.assessmentRole === "required"))
      add("invalid_lesson", "A lesson containing only optional tasks needs grounded reading for its normal-route position");
  }
  if (usedTasks.size !== taskIds.size) add("unknown_reference", "Every task must occupy a planned lesson block");
  for (const task of plan.tasks) {
    const mechanic = catalog.entries.find((entry) => entry.id === task.mechanicId && entry.version === task.mechanicVersion);
    if (!mechanic || mechanic.status !== "available") add("unsupported_task", "The intended learner action requires an unavailable mechanic/version");
    else if (task.design.affordances.some((affordance) => !mechanic.requiredAffordances.includes(affordance))) add("unsupported_task", "Task selection cites unsupported affordances");
    const lesson = plan.lessons.find((entry) => entry.id === task.lessonId);
    if (!lesson || task.outcomeIds.some((id) => !lesson.outcomeIds.includes(id)) || task.design.taskId !== task.id) add("unknown_reference", "Task design, lesson and outcomes must join");
    if (task.design.purpose === "demonstration" ? task.design.transfer === null : task.design.transfer !== null) add("invalid_transfer", "Only demonstrations require an explicit transfer design");
    if (new Set(task.outcomeIds).size !== task.outcomeIds.length || task.criteria.length !== task.outcomeIds.length || new Set(task.criteria.map((entry) => entry.outcomeId)).size !== task.criteria.length) add("criterion_mismatch", "Task criteria must map every task outcome exactly once");
    for (const criterion of task.criteria) {
      const known = input.knowledge.outcomes.find((outcome) => outcome.outcomeId === criterion.outcomeId);
      if (!task.outcomeIds.includes(criterion.outcomeId) || !known || new Set(criterion.criterionIds).size !== criterion.criterionIds.length || criterion.criterionIds.some((id) => !known.criteria.some((item) => item.id === id))) add("criterion_mismatch", "Task criteria must use the canonical researched outcome criteria");
    }
  }
  if (plan.coverage.length !== approved.outcomeIds.length || new Set(plan.coverage.map((entry) => entry.outcomeId)).size !== plan.coverage.length || approved.outcomeIds.some((id) => !plan.coverage.some((entry) => entry.outcomeId === id))) add("missing_outcome", "The plan must retain every approved module outcome");
  for (const entry of plan.coverage) {
    const required = input.knowledge.outcomes.find((outcome) => outcome.outcomeId === entry.outcomeId)?.criteria.map((criterion) => criterion.id) ?? [];
    const introduced = Math.min(...entry.introducedAt.map((reference) => positions.get(reference.blockId) ?? Infinity));
    for (const reference of entry.introducedAt) {
      const lesson = plan.lessons.find((item) => item.id === reference.lessonId), block = lesson?.blocks.find((item) => item.id === reference.blockId);
      if (!block || block.kind === "task" || !block.outcomeIds.includes(entry.outcomeId)) add("unknown_reference", "Introduction references must identify reading for the actual outcome");
    }
    for (const [purpose, references] of [["practice", entry.practicedTaskIds], ["demonstration", entry.demonstratedTaskIds]] as const) {
      const criteria = new Set<string>();
      for (const id of references) {
        const task = plan.tasks.find((item) => item.id === id);
        if (!task || task.design.purpose !== purpose || !task.outcomeIds.includes(entry.outcomeId)) add("invalid_transfer", "Coverage references must match task purpose and outcome");
        if (task?.assessmentRole !== "required") add("criterion_mismatch", "Normal coverage must reference required tasks, not optional adaptive material");
        if ((positions.get(id) ?? -1) <= introduced) add("prerequisite_order", "Reading must precede the practice and demonstration it supports");
        task?.criteria.find((item) => item.outcomeId === entry.outcomeId)?.criterionIds.forEach((criterion) => criteria.add(criterion));
        if (purpose === "demonstration" && (!task?.design.transfer || task.design.transfer.fromTaskIds.some((prior) => !entry.practicedTaskIds.includes(prior) || (positions.get(prior) ?? Infinity) >= (positions.get(id) ?? -1)))) add("invalid_transfer", "Transfer must depend on distinct earlier practice for the same outcome");
      }
      if (required.some((criterion) => !criteria.has(criterion))) add("criterion_mismatch", "Every canonical criterion needs both planned practice and demonstration");
    }
    for (const role of ["practice", "diagnostic", "challenge"] as const) {
      const available = new Set(plan.tasks.filter((task) => task.assessmentRole === role)
        .flatMap((task) => task.criteria.filter((item) => item.outcomeId === entry.outcomeId).flatMap((item) => item.criterionIds)));
      if (required.some((criterion) => !available.has(criterion))) add("criterion_mismatch", `Every canonical criterion needs meaningful optional ${role} material outside the normal route`);
    }
  }
  return issues;
}
