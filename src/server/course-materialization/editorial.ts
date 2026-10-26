import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema, JsonValueSchema } from "@/domain/common";
import { CourseVersionSchema, CurriculumDraftSchema } from "@/domain/course";
import { LessonSchema } from "@/domain/learning";
import { TaskPrivateSchema } from "@/domain/mechanics";
import type { DbTransaction } from "@/server/db";
import { loadStoppedBuildForRelease } from "@/server/curricula/build-binding";
import { AuthoredModuleSchema } from "@/server/course-generation/contracts";
import { ModulePlanSchema, LessonReadingSchema, validateModulePlan } from "@/server/course-generation/planning";
import { GenerationEvidenceRepository } from "@/server/course-generation/repository";
import { loadVerifiedModulePlan } from "@/server/course-generation/plan-stages";
import { loadVerifiedLessonReading } from "@/server/course-generation/reading-stages";
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { validateCourseCoverage } from "@/server/course-validation/coverage";
import { validateAdaptiveMaterial } from "@/server/course-validation/adaptive-material";
import { prepareTaskCandidate } from "@/server/mechanics/materialization";
import { getServerMechanic } from "@/server/mechanics/registry";
import { getAssessmentDimensionIds } from "@/server/mechanics/catalog";
import type { MechanicRuntimeCapabilities, PreparedTaskCandidate } from "@/server/mechanics/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { GradeDecisionSchema } from "@/server/evaluation/contracts";
import { createNormalProgramEntries } from "@/server/learning/initial-route";
import { stableExecutionId } from "@/server/runs/identity";
import { courseVersionFromRow } from "@/server/catalog/projections";
import { EditorialPreviewMetadataSchema, previewFromVersion } from "./preview-metadata";

export const EditorialTaskSchema = z.object({ lessonId: IdSchema, authored: AuthoredModuleSchema.shape.tasks.element,
  validResponse: JsonValueSchema, wrongResponse: JsonValueSchema }).strict();
export const EditorialContentSchema = z.object({
  sourceRunId: IdSchema, sourcePlanStepId: IdSchema, sourceKnowledgeStepId: IdSchema,
  sourceReadingStepIds: z.array(IdSchema).min(1), moduleId: IdSchema, approvalDigest: DigestSchema,
  plan: ModulePlanSchema, readings: z.array(LessonReadingSchema).min(1), tasks: z.array(EditorialTaskSchema).min(1),
}).strict();
export const EditorialReleaseInputSchema = z.object({ runId: IdSchema, ownerId: IdSchema, applyDigest: DigestSchema.optional() }).strict();
const reject = (reason: string): never => { throw new Error(`Editorial release rejected: ${reason}`); };
function requireNoIssues(issues: readonly { message: string }[], label: string) {
  if (issues.length) reject(`${label}: ${issues.map(({ message }) => message).join("; ")}`);
}

/** Local evaluation evidence only; deliberately never a mechanic-readiness/model-review receipt. */
export async function validateEditorialTask(candidate: PreparedTaskCandidate, input: z.infer<typeof EditorialTaskSchema>) {
  const fresh = prepareTaskCandidate(input.authored, { approvalDigest: candidate.approvalDigest });
  if (taskDigest(fresh) !== taskDigest(candidate)) return reject("candidate changed");
  const handle = getServerMechanic(candidate.task.mechanicId, candidate.task.mechanicVersion);
  if (!handle || candidate.task.mechanicVersion !== 2 || candidate.privateTask.evaluationSpec.kind !== "deterministic"
    || handle.descriptor.requirements.some((requirement) => ["model", "activity", "sandbox"].includes(requirement))
    || handle.descriptor.actions.length) return reject("editorial tasks require a pure deterministic evaluator");
  const dimensions = getAssessmentDimensionIds(candidate.task, candidate.privateTask.evaluatorData);
  const cases = [];
  for (const [category, raw] of [["valid", input.validResponse], ["invalid", input.wrongResponse]] as const) {
    const response = handle.parseResponse(raw);
    if (handle.descriptor.validateSubmission(candidate.task.config, response).length) return reject(`${category} response must be a valid learner submission`);
    const decision = GradeDecisionSchema.parse(await handle.evaluate({ task: candidate.task, privateData: candidate.privateTask.evaluatorData,
      response, activity: null }, { model: null, signal: new AbortController().signal }));
    const correct = decision.status === "evaluated" && decision.outcome === "correct" && decision.dimensions.length === dimensions.length
      && dimensions.every((id) => decision.dimensions.some((dimension) => dimension.id === id && dimension.status === "met"));
    if (category === "valid" ? !correct : decision.status !== "evaluated" || decision.outcome === "correct"
      || !decision.dimensions.some((dimension) => dimension.status === "not_met")) return reject(`${category} evaluator case failed`);
    cases.push({ category, response, decision });
  }
  return { validatorVersion: "editorial-deterministic-v1" as const, candidateDigest: candidate.candidateDigest,
    approvalDigest: candidate.approvalDigest, capabilityCatalogDigest: candidate.capabilityCatalogDigest,
    sourceClaimIds: candidate.privateTask.sourceClaimIds, cases, verdict: "passed" as const };
}

/** Explicit operator: source generation stays stopped and its immutable records are only read. */
export async function releaseEditorialFirstSection(tx: DbTransaction, rawInput: unknown, rawContent: unknown, runtime: MechanicRuntimeCapabilities) {
  const input = EditorialReleaseInputSchema.parse(rawInput), content = EditorialContentSchema.parse(rawContent);
  const apply = input.applyDigest !== undefined, editorialContentDigest = taskDigest(content);
  if (content.sourceRunId !== input.runId) return reject("source run mismatch");
  const existing = (await tx.query(`SELECT v.*,c.slug,c.visibility,c.published_version_id FROM unfurl.course_versions v
    JOIN unfurl.courses c ON c.id=v.course_id WHERE v.source_run_id=$1 AND c.owner_id=$2`, [input.runId, input.ownerId])).rows;
  if (existing.length !== 1) return reject("source version is not unique");
  const row = existing[0]!;
  const report = (metadata: z.infer<typeof EditorialPreviewMetadataSchema>, alreadyReleased: boolean) => ({
    kind: "official-editorial-course-release", applied: apply, alreadyReleased, inferenceCalls: 0, runId: input.runId,
    courseId: row.course_id, courseVersionId: row.id, coursePath: `/courses/${row.slug}`, releaseDigest: metadata.releaseDigest,
    editorialContentDigest, plannedModuleCount: metadata.presentation.plannedModules.length,
    lessonCount: metadata.presentation.lessons.length, taskCount: content.tasks.length,
  });
  if (row.release_metadata) {
    const metadata = previewFromVersion(row.release_metadata, courseVersionFromRow(row));
    if (!metadata || metadata.kind !== "official-editorial-section-v1" || metadata.editorialContentDigest !== editorialContentDigest
      || row.state !== "ready" || row.visibility !== "public" || row.published_version_id !== row.id
      || input.applyDigest && input.applyDigest !== metadata.releaseDigest) return reject("existing release differs");
    return report(metadata, true);
  }
  const binding = await loadStoppedBuildForRelease(tx, { runId: input.runId, ownerId: input.ownerId, lock: apply });
  if (binding.run.outputVersionId !== null || binding.course.currentReadyVersionId !== null || binding.course.publishedVersionId !== null
    || binding.approval.contentDigest !== content.approvalDigest) return reject("source binding changed");
  const jobs = (await tx.query<{ id: string; status: string }>(`SELECT id,status FROM unfurl.execution_jobs WHERE generation_run_id=$1 ${apply ? "FOR UPDATE" : ""}`, [input.runId])).rows;
  if (jobs.length !== 1 || !["failed", "cancelled"].includes(jobs[0]!.status)) return reject("source job has not stopped");
  const busy = (await tx.query(`SELECT id FROM unfurl.generation_runs WHERE course_id=$1 AND status IN ('queued','running','awaiting_user')
    UNION ALL SELECT id FROM unfurl.run_steps WHERE job_id=$2 AND status IN ('pending','running') LIMIT 1`, [binding.course.id, jobs[0]!.id])).rows;
  if (busy.length) return reject("course has active work");
  const first = binding.draft.modules[0], outcomeIds = new Set(first?.outcomeIds);
  if (!first || first.id !== content.moduleId || first.id !== content.plan.moduleId || first.prerequisiteModuleIds.length || binding.draft.modules.length < 2) return reject("first section is not independent");
  const scopedDraft = CurriculumDraftSchema.parse({ ...binding.draft, modules: [first], outcomes: binding.draft.outcomes.filter(({ id }) => outcomeIds.has(id)) });
  if (scopedDraft.outcomes.some(({ prerequisiteOutcomeIds }) => prerequisiteOutcomeIds.some((id) => !outcomeIds.has(id)))) return reject("section requires unavailable outcomes");
  const knowledge = await new GenerationEvidenceRepository().loadKnowledge(tx, binding, content.sourceKnowledgeStepId);
  const original = await loadVerifiedModulePlan(tx, binding, content.sourcePlanStepId, knowledge.knowledge);
  const readingShape = (plan: z.infer<typeof ModulePlanSchema>) => plan.lessons.map((lesson) => ({ ...lesson, blocks: lesson.blocks.filter((block) => block.kind !== "task") }));
  if (taskDigest(readingShape(original.plan)) !== taskDigest(readingShape(content.plan))) return reject("saved reading plan changed");
  if (content.sourceReadingStepIds.length !== original.plan.lessons.length || new Set(content.sourceReadingStepIds).size !== content.sourceReadingStepIds.length) return reject("reading source identities differ");
  const readings: z.infer<typeof LessonReadingSchema>[] = [];
  for (const [index, lesson] of original.plan.lessons.entries()) readings.push(await loadVerifiedLessonReading(tx, binding,
    content.sourceReadingStepIds[index]!, content.sourcePlanStepId, lesson, knowledge.facts, knowledge.knowledge));
  if (taskDigest(readings) !== taskDigest(content.readings)) return reject("saved reading content changed");
  requireNoIssues(validateModulePlan(content.plan, { draft: scopedDraft, knowledge: knowledge.knowledge, runtime }), "plan");
  if (content.tasks.length !== content.plan.tasks.length || content.tasks.some(({ lessonId, authored }) => {
    const slot = content.plan.tasks.find(({ id }) => id === authored.task.id);
    return !slot || slot.lessonId !== lessonId || slot.assessmentRole !== authored.privateTask.assessment.role
      || taskDigest(slot.design) !== taskDigest(authored.design) || taskDigest(slot.outcomeIds) !== taskDigest(authored.task.outcomeIds);
  })) return reject("authored task plan differs");
  const lessons = content.plan.lessons.map((lesson) => LessonSchema.parse({ id: lesson.id, courseVersionId: binding.version.id,
    moduleId: first.id, title: lesson.title, outcomeIds: lesson.outcomeIds,
    blocks: lesson.blocks.map((block) => block.kind === "task" ? block : readings.find((reading) => reading.lessonId === lesson.id)!.blocks.find(({ id }) => id === block.id)),
    taskIds: lesson.blocks.flatMap((block) => block.kind === "task" ? [block.taskId] : []) }));
  const prepared = prepareModuleCandidate({ schemaVersion: 1, moduleId: first.id, approvalDigest: content.approvalDigest,
    lessons, tasks: content.tasks.map(({ authored }) => authored), readingEvidence: readings.flatMap((reading) => reading.readingEvidence) },
  { ...knowledge.facts, draft: scopedDraft, approvalDigest: content.approvalDigest, courseVersionId: binding.version.id, knowledge: knowledge.knowledge });
  requireNoIssues(prepared.issues, "module");
  if (!prepared.candidate) return reject("module is not prepared");
  const section = prepared.candidate;
  requireNoIssues(validateCourseCoverage({ draft: scopedDraft, approvalDigest: content.approvalDigest, courseVersionId: binding.version.id,
    modules: [section], coverage: content.plan.coverage }), "coverage");
  requireNoIssues(validateAdaptiveMaterial([section]), "adaptive material");
  const version = CourseVersionSchema.parse({ ...binding.version, state: "validating", summary: first.summary,
    outcomes: scopedDraft.outcomes, modules: scopedDraft.modules, lessonIds: lessons.map(({ id }) => id) });
  createNormalProgramEntries({ version, lessons, tasks: section.tasks.map(({ candidate }) => ({ task: candidate.task, assessment: candidate.privateTask.assessment })) });
  const proofs = [];
  for (const { candidate } of section.tasks) proofs.push(await validateEditorialTask(candidate, content.tasks.find(({ authored }) => authored.task.id === candidate.task.id)!));
  const body = { kind: "official-editorial-section-v1" as const, publisher: "Unfurl" as const, sourceRunId: input.runId,
    approvalId: binding.approval.id, approvalDigest: content.approvalDigest, courseVersionId: version.id,
    sourcePlanStepId: content.sourcePlanStepId, sourceKnowledgeStepId: content.sourceKnowledgeStepId,
    sourceReadingStepIds: content.sourceReadingStepIds, editorialContentDigest, moduleDigest: section.moduleDigest,
    presentation: { kind: "preview" as const, availableModuleIds: [first.id], plannedModules: binding.draft.modules,
      notice: "The first section is available to study. The rest of the curriculum is planned.",
      lessons: lessons.map((lesson) => ({ id: lesson.id, moduleId: first.id, title: lesson.title,
        tasks: lesson.taskIds.map((id) => { const task = section.tasks.find(({ candidate }) => candidate.task.id === id)!.candidate.task;
          return { id, instruction: task.instruction, mechanicId: task.mechanicId }; }) })) } };
  const metadata = EditorialPreviewMetadataSchema.parse({ ...body, releaseDigest: taskDigest(body) });
  if (!apply) return report(metadata, false);
  if (input.applyDigest !== metadata.releaseDigest) return reject("reviewed release changed");
  for (const lesson of lessons) await tx.query(`INSERT INTO unfurl.lessons(id,course_version_id,module_id,title,outcome_ids,blocks,task_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [lesson.id, version.id, lesson.moduleId, lesson.title, lesson.outcomeIds, JSON.stringify(lesson.blocks), lesson.taskIds]);
  const now = new Date().toISOString(), taskReceiptIds = [];
  for (const [index, { candidate }] of section.tasks.entries()) {
    const task = candidate.task, receiptId = stableExecutionId(task.id, "editorial-deterministic-v1");
    const privateTask = TaskPrivateSchema.parse({ ...candidate.privateTask, validationReceiptId: receiptId });
    await tx.query(`INSERT INTO unfurl.tasks_public(id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [task.id, task.taskVersion, version.id, task.mechanicId, task.mechanicVersion, task.outcomeIds, task.instruction, task.contentLanguage, JSON.stringify(task.config), task.availableHints, task.responseSchemaVersion]);
    const receipt = { id: receiptId, taskId: task.id, taskVersion: task.taskVersion, ...proofs[index], sourceRunId: input.runId, editorialContentDigest, createdAt: now };
    await tx.query(`INSERT INTO unfurl.task_validation_receipts(id,task_id,task_version,verdict,document) VALUES($1,$2,$3,'passed',$4)`, [receiptId, task.id, task.taskVersion, JSON.stringify(receipt)]);
    await tx.query(`INSERT INTO unfurl.tasks_private(task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [task.id, task.taskVersion, JSON.stringify(privateTask.evaluationSpec), privateTask.sourceClaimIds, receiptId, JSON.stringify(privateTask.hints), JSON.stringify(privateTask.workedExample), JSON.stringify(privateTask.evaluatorData), JSON.stringify(privateTask.assessment)]);
    taskReceiptIds.push(receiptId);
  }
  const receiptId = stableExecutionId(version.id, "official-editorial-section-v1"), receipt = { id: receiptId, courseVersionId: version.id,
    validatorVersion: "official-editorial-section-v1", verdict: "passed", sourceRunId: input.runId, approvalDigest: content.approvalDigest,
    contentDigest: metadata.releaseDigest, editorialContentDigest, moduleDigest: section.moduleDigest, taskReceiptIds,
    sourcePlanStepId: content.sourcePlanStepId, sourceKnowledgeStepId: content.sourceKnowledgeStepId, sourceReadingStepIds: content.sourceReadingStepIds,
    scope: { availableModuleIds: [first.id] }, coverage: content.plan.coverage, normalRouteValidated: true, adaptiveMaterialValidated: true, createdAt: now };
  await tx.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'passed',$3)", [receiptId, version.id, JSON.stringify(receipt)]);
  const cover = { motifId: "learning-path", alt: version.title };
  CourseVersionSchema.parse({ ...version, state: "ready", validationReceiptId: receiptId, cover, readyAt: now });
  const saved = await tx.query(`UPDATE unfurl.course_versions SET state='ready',summary=$2,outcomes=$3,modules=$4,lesson_ids=$5,
    validation_receipt_id=$6,cover=$7,ready_at=$8,release_metadata=$9 WHERE id=$1 AND state='failed' AND source_run_id=$10 AND release_metadata IS NULL RETURNING id`,
  [version.id, version.summary, JSON.stringify(version.outcomes), JSON.stringify(version.modules), version.lessonIds, receiptId, JSON.stringify(cover), now, JSON.stringify(metadata), input.runId]);
  if (saved.rows.length !== 1) return reject("source version changed");
  await tx.query(`UPDATE unfurl.courses SET current_ready_version_id=$2,published_version_id=$2,visibility='public',cover=$3,summary=$4,
    revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$5`, [binding.course.id, version.id, JSON.stringify(cover), version.summary, input.ownerId]);
  return report(metadata, false);
}

