import "server-only";
import { z } from "zod";
import { validateCurriculum, type CurriculumDraft } from "@/domain/course";
import { OutcomeCoverageSchema, PreparedModuleSchema, type GenerationValidationIssue, type PreparedModule } from "@/server/course-generation/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";

/** Reference/order checks are necessary evidence, never a semantic quality certificate. */
export function validateCourseCoverage(input: {
  draft: CurriculumDraft; approvalDigest: string; courseVersionId: string; modules: unknown; coverage: unknown;
}): GenerationValidationIssue[] {
  const parsedModules = z.array(PreparedModuleSchema).safeParse(input.modules);
  const parsedCoverage = z.array(OutcomeCoverageSchema).safeParse(input.coverage);
  if (!parsedModules.success || !parsedCoverage.success) return [{ code: "invalid_shape", path: [], message: "Coverage requires strict prepared modules and actual references" }];
  const modules = parsedModules.data, coverage = parsedCoverage.data;
  const issues: GenerationValidationIssue[] = [];
  const add = (code: GenerationValidationIssue["code"], path: GenerationValidationIssue["path"], message: string) => issues.push({ code, path, message });
  if (validateCurriculum(input.draft).length) add("invalid_shape", ["draft"], "Approved curriculum has invalid dependencies or membership");
  const moduleIds = modules.map((section) => section.moduleId), expectedModules = input.draft.modules.map((section) => section.id);
  if (new Set(moduleIds).size !== moduleIds.length || moduleIds.length !== expectedModules.length || expectedModules.some((id) => !moduleIds.includes(id))) add("missing_outcome", ["modules"], "Every approved section must be materialized exactly once");
  const positions = new Map<string, number>(), lessons = new Map<string, PreparedModule["lessons"][number]>();
  const tasks = new Map<string, PreparedModule["tasks"][number]>(), readings = new Map<string, PreparedModule["readingEvidence"][number]>();
  const criteria = new Map<string, Map<string, string>>();
  let position = 0;
  for (const section of modules) {
    const { moduleDigest, ...content } = section;
    if (moduleDigest !== taskDigest(content)) add("stale_candidate", ["modules", section.moduleId], "Module content changed after preparation");
    if (section.approvalDigest !== input.approvalDigest || section.knowledge.approvalDigest !== input.approvalDigest || section.knowledge.moduleId !== section.moduleId) add("stale_approval", ["modules", section.moduleId], "Prepared section belongs to another approval");
    const outline = input.draft.modules.find((item) => item.id === section.moduleId);
    if (outline?.prerequisiteModuleIds.some((id) => moduleIds.indexOf(id) >= moduleIds.indexOf(section.moduleId))) add("prerequisite_order", ["modules", section.moduleId], "Prerequisite modules must precede dependent modules");
    for (const outcome of section.knowledge.outcomes) {
      const mapped = criteria.get(outcome.outcomeId) ?? new Map<string, string>();
      for (const criterion of outcome.criteria) {
        if (mapped.has(criterion.id) && mapped.get(criterion.id) !== criterion.description) add("criterion_mismatch", ["criteria", outcome.outcomeId], "A stable criterion cannot change meaning between modules");
        mapped.set(criterion.id, criterion.description);
      }
      criteria.set(outcome.outcomeId, mapped);
    }
    for (const task of section.tasks) {
      if (tasks.has(task.candidate.task.id)) add("duplicate_reference", ["tasks"], "Task IDs are unique across the course version");
      tasks.set(task.candidate.task.id, task);
      try {
        const fresh = prepareTaskCandidate({ task: task.candidate.task, privateTask: task.candidate.privateTask }, { approvalDigest: input.approvalDigest });
        if (taskDigest(fresh) !== taskDigest(task.candidate)) throw new Error();
      } catch { add("stale_candidate", ["tasks", task.candidate.task.id], "Task preparation is stale or invalid"); }
    }
    for (const lesson of section.lessons) {
      if (lessons.has(lesson.id)) add("duplicate_reference", ["lessons"], "Lesson IDs are unique across the course version");
      lessons.set(lesson.id, lesson);
      if (lesson.courseVersionId !== input.courseVersionId || lesson.moduleId !== section.moduleId) add("unknown_reference", ["lessons", lesson.id], "Lesson belongs to another version/section");
      if (!outline || lesson.outcomeIds.some((id) => !outline.outcomeIds.includes(id))) add("unknown_reference", ["lessons", lesson.id], "Lesson outcomes are outside the approved module");
      const taskBlocks = lesson.blocks.flatMap((block) => block.kind === "task" ? [block.taskId] : []);
      if (new Set(lesson.taskIds).size !== lesson.taskIds.length || taskBlocks.length !== lesson.taskIds.length || taskBlocks.some((id) => !lesson.taskIds.includes(id))) add("invalid_lesson", ["lessons", lesson.id], "Lesson task membership does not match its actual blocks");
      if (!lesson.blocks.some((block) => block.kind !== "task") && !taskBlocks.some((id) => tasks.get(id)?.candidate.privateTask.assessment.role === "required")) add("invalid_lesson", ["lessons", lesson.id], "A normal lesson needs required practice or reading material");
      for (const block of lesson.blocks) {
        if (block.kind === "task") {
          const task = tasks.get(block.taskId);
          if (!task || task.candidate.task.outcomeIds.some((id) => !lesson.outcomeIds.includes(id))) add("unknown_reference", ["lessons", lesson.id], "Task must belong to its actual lesson outcomes");
        }
        const key = block.kind === "task" ? `task:${block.taskId}` : `reading:${lesson.id}:${block.id}`;
        if (positions.has(key)) add("duplicate_reference", ["lessons", lesson.id], "A block/task cannot occupy multiple course positions");
        positions.set(key, position++);
      }
    }
    for (const reading of section.readingEvidence) readings.set(`${reading.lessonId}:${reading.blockId}`, reading);
  }
  for (const id of tasks.keys()) if (!positions.has(`task:${id}`)) add("unknown_reference", ["tasks", id], "Every prepared task needs a real lesson position");
  const outcomeIds = input.draft.outcomes.map((outcome) => outcome.id);
  if (new Set(coverage.map((entry) => entry.outcomeId)).size !== coverage.length || coverage.length !== outcomeIds.length || outcomeIds.some((id) => !coverage.some((entry) => entry.outcomeId === id))) add("missing_outcome", ["coverage"], "Every approved outcome, including specialization, needs complete coverage");
  const introductionPosition = new Map<string, number>(), demonstrationPosition = new Map<string, number>();
  for (const entry of coverage) {
    const path = ["coverage", entry.outcomeId];
    if (!outcomeIds.includes(entry.outcomeId)) add("unknown_reference", path, "Coverage references an unapproved outcome");
    const introductions: number[] = [];
    const uniqueIntroductions = new Set<string>();
    for (const reference of entry.introducedAt) {
      const key = `${reference.lessonId}:${reference.blockId}`, reading = readings.get(key), at = positions.get(`reading:${key}`);
      if (uniqueIntroductions.has(key)) add("duplicate_reference", path, "Introduction references must be distinct");
      uniqueIntroductions.add(key);
      if (!reading?.outcomeIds.includes(entry.outcomeId) || at === undefined) add("unknown_reference", path, "Introduction must identify grounded reading for this outcome");
      else introductions.push(at);
    }
    const firstIntroduction = Math.min(...introductions);
    introductionPosition.set(entry.outcomeId, firstIntroduction);
    const requiredCriteria = new Set<string>(), practiceCriteria = new Set<string>(), demonstratedCriteria = new Set<string>();
    for (const [purpose, references] of [["practice", entry.practicedTaskIds], ["demonstration", entry.demonstratedTaskIds]] as const) {
      for (const id of references) {
        const task = tasks.get(id), at = positions.get(`task:${id}`);
        if (!task || at === undefined || !task.candidate.task.outcomeIds.includes(entry.outcomeId)) { add("unknown_reference", path, "Coverage must identify an actual task for this outcome"); continue; }
        if (task.design.purpose !== purpose) add("invalid_transfer", path, "Task purpose does not match its coverage role");
        if (at <= firstIntroduction) add("prerequisite_order", path, "Introduction must precede practice and demonstration");
        const assessment = task.candidate.privateTask.assessment;
        if (assessment.role !== "required") add("criterion_mismatch", path, "Coverage practice and demonstration must be included in the normal required route");
        for (const criterion of assessment.outcomes.find((outcome) => outcome.outcomeId === entry.outcomeId)?.dimensions ?? []) {
          (purpose === "practice" ? practiceCriteria : demonstratedCriteria).add(criterion.dimensionId);
          if (assessment.role === "required") requiredCriteria.add(criterion.dimensionId);
        }
        if (purpose === "demonstration") {
          demonstrationPosition.set(entry.outcomeId, Math.max(demonstrationPosition.get(entry.outcomeId) ?? -1, at));
          const transfer = task.design.transfer;
          if (!transfer || transfer.fromTaskIds.some((practiceId) => !entry.practicedTaskIds.includes(practiceId))) { add("invalid_transfer", path, "Demonstration must transfer from this outcome's practice"); continue; }
          for (const practiceId of transfer.fromTaskIds) {
            const practice = tasks.get(practiceId), practicedAt = positions.get(`task:${practiceId}`);
            if (!practice || practicedAt === undefined || practicedAt >= at || practiceId === id ||
              practice.candidate.privateTask.assessment.evidenceGroupId === assessment.evidenceGroupId ||
              taskDigest({ instruction: practice.candidate.task.instruction, config: practice.candidate.task.config }) === taskDigest({ instruction: task.candidate.task.instruction, config: task.candidate.task.config })) {
              add("invalid_transfer", path, "Transfer needs earlier, distinct practice and an independent task/evidence group");
            }
          }
        }
      }
    }
    const expected = criteria.get(entry.outcomeId);
    if (!expected?.size || [...expected.keys()].some((id) => !practiceCriteria.has(id) || !demonstratedCriteria.has(id) || !requiredCriteria.has(id))) add("criterion_mismatch", path, "Every researched criterion needs practice, demonstration and required assessment");
    if ([...practiceCriteria, ...demonstratedCriteria].some((id) => !expected?.has(id))) add("criterion_mismatch", path, "Coverage cannot invent canonical criteria");
  }
  for (const outcome of input.draft.outcomes) {
    for (const prerequisite of outcome.prerequisiteOutcomeIds) {
      const introduced = introductionPosition.get(prerequisite), demonstrated = demonstrationPosition.get(prerequisite);
      if (introduced === undefined || demonstrated === undefined || introduced >= (introductionPosition.get(outcome.id) ?? -1) || demonstrated >= (demonstrationPosition.get(outcome.id) ?? -1)) add("prerequisite_order", ["coverage", outcome.id], "Prerequisite outcomes must be introduced and demonstrated before dependent outcomes");
    }
  }
  return issues;
}
