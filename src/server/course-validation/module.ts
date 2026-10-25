import "server-only";
import { getMechanicManifest } from "@/domain/mechanic-manifest";
import { prepareTaskCandidate, TaskCandidateError } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";
import { AuthoredModuleSchema, ModuleKnowledgeSchema, type PreparedModule, type GenerationValidationIssue } from "@/server/course-generation/contracts";
import { knowledgeClaimIds, validateModuleKnowledge, type KnowledgeContext } from "./knowledge";

/** Produces a candidate only. No receipt, readiness claim or database write occurs here. */
export function prepareModuleCandidate(value: unknown, input: KnowledgeContext & { courseVersionId: string; knowledge: unknown }):
  { candidate: PreparedModule | null; issues: GenerationValidationIssue[] } {
  const issues = validateModuleKnowledge(input.knowledge, input);
  const authored = AuthoredModuleSchema.safeParse(value), knowledge = ModuleKnowledgeSchema.safeParse(input.knowledge);
  if (!authored.success || !knowledge.success) return { candidate: null, issues: [...issues, { code: "invalid_shape", path: [], message: "Module content must match its strict schema" }] };
  const section = authored.data;
  const add = (code: GenerationValidationIssue["code"], path: GenerationValidationIssue["path"], message: string) => issues.push({ code, path, message });
  if (section.approvalDigest !== input.approvalDigest || section.moduleId !== knowledge.data.moduleId) add("stale_approval", [], "Module and researched knowledge must share the current approval and section");
  const outline = input.draft.modules.find((entry) => entry.id === section.moduleId);
  if (!outline) return { candidate: null, issues: [...issues, { code: "unknown_reference", path: ["moduleId"], message: "Unknown approved section" }] };
  const lessons = new Map(section.lessons.map((lesson) => [lesson.id, lesson]));
  const tasks = new Map(section.tasks.map((entry) => [entry.task.id, entry]));
  if (lessons.size !== section.lessons.length || tasks.size !== section.tasks.length) add("duplicate_reference", [], "Lesson and task identities must be unique");
  const usedTasks = new Set<string>(), readingKeys = new Set<string>(), blockIds = new Set<string>();
  const allClaims = knowledgeClaimIds(knowledge.data);
  const claimMap = new Map(input.claims.map((claim) => [claim.id, claim]));
  const passageMap = new Map(input.passages.map((passage) => [passage.id, passage]));
  const prepared: PreparedModule["tasks"] = [];
  section.tasks.forEach((entry, index) => {
    const path = ["tasks", index];
    try {
      const candidate = prepareTaskCandidate(entry, { approvalDigest: input.approvalDigest });
      if (entry.design.taskId !== candidate.task.id) add("unknown_reference", path, "Task design references another task");
      if (candidate.task.contentLanguage !== input.draft.contentLanguage) add("invalid_task", path, "Task language differs from the approved course language");
      if (new Set(candidate.task.outcomeIds).size !== candidate.task.outcomeIds.length || candidate.task.outcomeIds.some((id) => !outline.outcomeIds.includes(id))) add("unknown_reference", path, "Task outcomes must be unique and belong to its approved section");
      const manifest = getMechanicManifest(candidate.task.mechanicId, candidate.task.mechanicVersion)!;
      if (new Set(entry.design.affordances).size !== entry.design.affordances.length || entry.design.affordances.some((affordance) => !manifest.requiredAffordances.includes(affordance))) add("unsupported_task", path, "Task selection cites an affordance the actual mechanic does not provide");
      if (entry.design.purpose === "demonstration" ? entry.design.transfer === null : entry.design.transfer !== null) add("invalid_transfer", path, "Demonstrations need a transfer design; other task purposes cannot claim one");
      if (candidate.privateTask.sourceClaimIds.length === 0 || candidate.privateTask.sourceClaimIds.some((id) => !allClaims.has(id))) add("invalid_source", path, "Tasks need claims from this section's validated knowledge");
      for (const outcomeId of candidate.task.outcomeIds) {
        if (!candidate.privateTask.sourceClaimIds.some((id) => knowledgeClaimIds(knowledge.data, outcomeId).has(id))) add("invalid_source", path, "Every task outcome needs its own grounded claim");
        const expected = knowledge.data.outcomes.find((item) => item.outcomeId === outcomeId)?.criteria.map((criterion) => criterion.id) ?? [];
        const mappings = candidate.privateTask.assessment.outcomes.find((item) => item.outcomeId === outcomeId)?.dimensions ?? [];
        if (mappings.some((mapping) => !expected.includes(mapping.dimensionId))) add("criterion_mismatch", path, "Task maps a criterion absent from the researched outcome");
      }
      prepared.push({ candidate, design: entry.design });
    } catch (error) { add(error instanceof TaskCandidateError && error.status === "unsupported" ? "unsupported_task" : "invalid_task", path, error instanceof Error ? error.message : "Invalid task candidate"); }
  });
  section.lessons.forEach((lesson, index) => {
    const path = ["lessons", index];
    if (lesson.courseVersionId !== input.courseVersionId || lesson.moduleId !== section.moduleId || lesson.outcomeIds.some((id) => !outline.outcomeIds.includes(id)) || new Set(lesson.outcomeIds).size !== lesson.outcomeIds.length) add("unknown_reference", path, "Lesson must join the actual version, section and outcomes");
    const blockTasks = lesson.blocks.flatMap((block) => block.kind === "task" ? [block.taskId] : []);
    if (new Set(lesson.taskIds).size !== lesson.taskIds.length || lesson.taskIds.length !== blockTasks.length || lesson.taskIds.some((id) => !blockTasks.includes(id))) add("invalid_lesson", path, "Lesson task references must match its task blocks exactly");
    let required = 0, reading = 0;
    lesson.blocks.forEach((block) => {
      if (blockIds.has(block.id)) add("duplicate_reference", path, "Block identities must be unique across the section");
      blockIds.add(block.id);
      if (block.kind === "task") {
        const task = tasks.get(block.taskId);
        if (!task || task.task.outcomeIds.some((id) => !lesson.outcomeIds.includes(id))) add("unknown_reference", path, "Task is missing or outside its lesson outcomes");
        if (usedTasks.has(block.taskId)) add("duplicate_reference", path, "A task cannot occupy more than one lesson position");
        usedTasks.add(block.taskId);
        if (task?.privateTask.assessment.role === "required") required++;
      } else {
        reading++;
        readingKeys.add(`${lesson.id}:${block.id}`);
        const body = block.kind === "explanation" ? block.markdown : block.content;
        if (!body.trim()) add("invalid_lesson", path, "A reading block must contain material");
        if (block.sourceIds.length === 0 || new Set(block.sourceIds).size !== block.sourceIds.length || block.sourceIds.some((id) => !input.authorizedSourceIds.has(id))) add("invalid_source", path, "Reading needs distinct authorized source references");
      }
    });
    if (required === 0 && reading === 0) add("invalid_lesson", path, "A normal lesson needs required practice or reading material");
  });
  if ([...tasks.keys()].some((id) => !usedTasks.has(id))) add("unknown_reference", ["tasks"], "Every authored task must occupy a lesson block");
  const evidenceKeys = new Set<string>();
  for (const entry of section.readingEvidence) {
    const key = `${entry.lessonId}:${entry.blockId}`, lesson = lessons.get(entry.lessonId), block = lesson?.blocks.find((item) => item.id === entry.blockId);
    if (evidenceKeys.has(key)) add("duplicate_reference", ["readingEvidence"], "Reading has one evidence mapping");
    evidenceKeys.add(key);
    if (!block || block.kind === "task" || !readingKeys.has(key) || entry.outcomeIds.some((id) => !lesson!.outcomeIds.includes(id))) { add("unknown_reference", ["readingEvidence"], "Reading evidence must reference a real block and its outcomes"); continue; }
    if (entry.claimIds.some((id) => !allClaims.has(id))) add("invalid_source", ["readingEvidence"], "Reading claim is outside this section's researched knowledge");
    for (const outcomeId of entry.outcomeIds) if (!entry.claimIds.some((id) => knowledgeClaimIds(knowledge.data, outcomeId).has(id))) add("invalid_source", ["readingEvidence"], "Reading outcome lacks a supporting claim");
    const supportingSources = new Set(entry.claimIds.flatMap((id) => claimMap.get(id)?.passageIds.flatMap((passageId) => passageMap.get(passageId) ? [passageMap.get(passageId)!.sourceId] : []) ?? []));
    if (block.sourceIds.some((id) => !supportingSources.has(id)) || [...supportingSources].some((id) => !block.sourceIds.includes(id))) add("invalid_source", ["readingEvidence"], "Reading citations must match its actual claim passages");
  }
  if ([...readingKeys].some((key) => !evidenceKeys.has(key))) add("invalid_source", ["readingEvidence"], "Every reading block needs explicit claim evidence");
  if (issues.length) return { candidate: null, issues };
  const content = { ...section, tasks: prepared, knowledge: knowledge.data };
  return { candidate: { ...content, moduleDigest: taskDigest(content) }, issues };
}
