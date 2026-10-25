import "server-only";
import { z } from "zod";
import { CourseVersionSchema } from "@/domain/course";
import { LessonSchema } from "@/domain/learning";
import type { DbTransaction } from "@/server/db";
import type { RunContext } from "@/server/runs/ports";
import { stableExecutionId } from "@/server/runs/identity";
import { loadApprovedBuild, type ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { ProviderFailure } from "@/server/ai/failure";
import { GenerationEvidenceRepository, loadGenerationStep, type StoredGenerationStep } from "@/server/course-generation/repository";
import { CompletedModuleCheckpointSchema, type CompletedModuleCheckpoint } from "@/server/course-generation/completion";
import { LessonReadingSchema, validateModulePlan } from "@/server/course-generation/planning";
import { loadVerifiedModulePlan } from "@/server/course-generation/plan-stages";
import { LessonReadingCheckpointSchema, loadVerifiedLessonReading } from "@/server/course-generation/reading-stages";
import { prepareModuleCandidate } from "@/server/course-validation/module";
import { mergeOutcomeCoverage, validateCourseCoverage } from "@/server/course-validation/coverage";
import { createModuleReviewInput } from "@/server/course-validation/module-review";
import { loadVerifiedModuleReview } from "@/server/course-generation/module-review-stages";
import { TaskValidationRepository } from "@/server/course-validation/receipts";
import { materializeValidatedTask } from "@/server/mechanics/materialization";
import { taskDigest } from "@/server/mechanics/digest";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { createNormalProgramEntries } from "@/server/learning/initial-route";
import { validateAdaptiveMaterial } from "@/server/course-validation/adaptive-material";

const invalid = (): never => { throw new ProviderFailure("invalid_output"); };
export async function findReusableCompletedModule(tx: DbTransaction, binding: ApprovedBuildBinding, moduleId: string, runtime: MechanicRuntimeCapabilities) {
  const row = (await tx.query<{ id: string }>(`WITH RECURSIVE lineage AS (
    SELECT id,retry_of_run_id,ARRAY[id] AS path,0 AS depth FROM unfurl.generation_runs WHERE id=$1
    UNION ALL SELECT parent.id,parent.retry_of_run_id,lineage.path||parent.id,lineage.depth+1
    FROM unfurl.generation_runs parent JOIN lineage ON parent.id=lineage.retry_of_run_id
    WHERE parent.status IN ('failed','cancelled') AND NOT parent.id=ANY(lineage.path)
  ) SELECT step.id FROM lineage JOIN unfurl.execution_jobs job ON job.generation_run_id=lineage.id
    JOIN unfurl.run_steps step ON step.job_id=job.id
    WHERE lineage.depth>0 AND step.status='succeeded' AND step.result_reference->>'kind'='course.module.completed'
      AND step.result_reference->'module'->>'moduleId'=$2 ORDER BY lineage.depth LIMIT 1`, [binding.run.id, moduleId])).rows[0];
  if (!row) return null;
  const step = await loadGenerationStep(tx, binding, row.id, CompletedModuleCheckpointSchema);
  return { sourceStepId: step.id, checkpoint: await loadVerifiedModule(tx, binding, step, runtime) };
}
/** Completed checkpoint reuse always revalidates original immutable model, source and case records. */
export async function loadVerifiedModule(tx: DbTransaction, binding: ApprovedBuildBinding,
  step: StoredGenerationStep<CompletedModuleCheckpoint>, runtime: MechanicRuntimeCapabilities): Promise<CompletedModuleCheckpoint> {
  const stored = CompletedModuleCheckpointSchema.parse(step.result), evidence = new GenerationEvidenceRepository();
  const knowledge = await evidence.loadKnowledge(tx, binding, stored.knowledgeStepId);
  const { plan } = await loadVerifiedModulePlan(tx, binding, stored.planStepId, knowledge.knowledge);
  if (validateModulePlan(plan, { draft: binding.draft, knowledge: knowledge.knowledge, runtime }).length || taskDigest(plan.coverage) !== taskDigest(stored.coverage)) return invalid();
  const readings: z.infer<typeof LessonReadingSchema>[] = [];
  for (const id of stored.readingStepIds) {
    const readingStep = await loadGenerationStep(tx, binding, id, LessonReadingCheckpointSchema);
    const lesson = plan.lessons.find((entry) => entry.id === readingStep.result.reading.lessonId);
    if (!lesson) return invalid();
    readings.push(await loadVerifiedLessonReading(tx, binding, id, stored.planStepId, lesson, knowledge.facts, knowledge.knowledge));
  }
  if (new Set(readings.map((r) => r.lessonId)).size !== plan.lessons.length || readings.length !== plan.lessons.length) return invalid();
  const tasks = [], validation = new TaskValidationRepository(evidence);
  for (const references of stored.taskReferences) {
    const loaded = await evidence.loadTaskCandidate(tx, binding, references.candidateStepId);
    const proof = await validation.validateStoredTask(tx, binding, references);
    if (proof.receipt.verdict !== "passed" || loaded.step.result.moduleId !== stored.module.moduleId) return invalid();
    tasks.push(loaded.step.result.authored);
  }
  if (tasks.length !== plan.tasks.length || tasks.some((task) => !plan.tasks.some((slot) => slot.id === task.task.id && slot.assessmentRole === task.privateTask.assessment.role && taskDigest(slot.design) === taskDigest(task.design)))) return invalid();
  const lessons = plan.lessons.map((lesson) => {
    const reading = readings.find((r) => r.lessonId === lesson.id);
    if (!reading || reading.blocks.length !== lesson.blocks.filter((b) => b.kind !== "task").length) return invalid();
    return LessonSchema.parse({ id: lesson.id, courseVersionId: binding.version.id, moduleId: plan.moduleId, title: lesson.title, outcomeIds: lesson.outcomeIds,
      blocks: lesson.blocks.map((block) => block.kind === "task" ? block : reading.blocks.find((b) => b.id === block.id && b.kind === block.kind)),
      taskIds: lesson.blocks.flatMap((block) => block.kind === "task" ? [block.taskId] : []) });
  });
  const prepared = prepareModuleCandidate({ schemaVersion: 1, moduleId: plan.moduleId, approvalDigest: binding.approval.contentDigest,
    lessons, tasks, readingEvidence: readings.flatMap((r) => r.readingEvidence) }, { ...knowledge.facts, draft: binding.draft, knowledge: knowledge.knowledge, approvalDigest: binding.approval.contentDigest, courseVersionId: binding.version.id });
  if (!prepared.candidate || taskDigest(prepared.candidate) !== taskDigest(stored.module)) return invalid();
  if (validateAdaptiveMaterial([prepared.candidate]).length) return invalid();
  if (!(await loadVerifiedModuleReview(tx, binding, stored.reviewStepId, createModuleReviewInput(prepared.candidate, binding.draft, knowledge.facts))).passed) return invalid();
  return stored;
}

/** The only content write: complete validated modules, route and ready pointer commit atomically with run completion. */
export async function materializeCourse(tx: DbTransaction, context: RunContext, previous: ApprovedBuildBinding,
  modules: CompletedModuleCheckpoint[], runtime: MechanicRuntimeCapabilities): Promise<void> {
  const binding = await loadApprovedBuild(tx, { runId: previous.run.id, ownerId: previous.course.ownerId, lock: true });
  if (binding.version.id !== previous.version.id || binding.approval.contentDigest !== previous.approval.contentDigest) return invalid();
  const prepared = modules.map((entry) => entry.module), coverageByModule = modules.map((entry) => ({ moduleId: entry.module.moduleId, coverage: entry.coverage }));
  const coverage = mergeOutcomeCoverage(coverageByModule.flatMap((entry) => entry.coverage));
  if (validateCourseCoverage({ draft: binding.draft, approvalDigest: binding.approval.contentDigest, courseVersionId: binding.version.id, modules: prepared, coverage }).length) return invalid();
  if (validateAdaptiveMaterial(prepared).length) return invalid();
  const lessons = prepared.flatMap((module) => module.lessons), tasks = prepared.flatMap((module) => module.tasks);
  const version = CourseVersionSchema.parse({ ...binding.version, lessonIds: lessons.map((lesson) => lesson.id) });
  createNormalProgramEntries({ version, lessons, tasks: tasks.map(({ candidate }) => ({ task: candidate.task, assessment: candidate.privateTask.assessment })) });
  const validation = new TaskValidationRepository(), proofIds: string[] = [];
  for (const lesson of lessons) await tx.query(`INSERT INTO unfurl.lessons(id,course_version_id,module_id,title,outcome_ids,blocks,task_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [lesson.id, version.id, lesson.moduleId, lesson.title, lesson.outcomeIds, JSON.stringify(lesson.blocks), lesson.taskIds]);
  for (const references of modules.flatMap((module) => module.taskReferences)) {
    const proof = await validation.validateStoredTask(tx, binding, references);
    if (proof.receipt.verdict !== "passed" || !tasks.some(({ candidate }) => taskDigest(candidate) === taskDigest(proof.candidate))) return invalid();
    const task = proof.candidate.task;
    await tx.query(`INSERT INTO unfurl.tasks_public(id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [task.id, task.taskVersion, version.id, task.mechanicId, task.mechanicVersion, task.outcomeIds, task.instruction, task.contentLanguage, JSON.stringify(task.config), task.availableHints, task.responseSchemaVersion]);
    const receipt = await validation.persistReceipt(tx, proof), materialized = materializeValidatedTask(proof.candidate, { runtime, receipt }), privateTask = materialized.privateTask;
    await tx.query(`INSERT INTO unfurl.tasks_private(task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [task.id, task.taskVersion, JSON.stringify(privateTask.evaluationSpec), privateTask.sourceClaimIds, receipt.id, JSON.stringify(privateTask.hints), JSON.stringify(privateTask.workedExample), JSON.stringify(privateTask.evaluatorData), JSON.stringify(privateTask.assessment)]);
    proofIds.push(receipt.id);
  }
  const receiptId = stableExecutionId(version.id, "course-validation-v1"), contentDigest = taskDigest({ modules: prepared, coverage, coverageByModule });
  const receipt = { id: receiptId, courseVersionId: version.id, approvalDigest: binding.approval.contentDigest, contentDigest, verdict: "passed",
    validatorVersion: "course-generation-v1", moduleDigests: prepared.map((m) => ({ moduleId: m.moduleId, digest: m.moduleDigest })), taskReceiptIds: proofIds,
    reviewStepIds: modules.map((m) => m.reviewStepId), coverage, coverageByModule, normalRouteValidated: true, adaptiveMaterialValidated: true, createdAt: new Date().toISOString() };
  await tx.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'passed',$3)", [receiptId, version.id, JSON.stringify(receipt)]);
  const cover = { motifId: "learning-path", alt: version.title };
  CourseVersionSchema.parse({ ...version, state: "ready", validationReceiptId: receiptId, cover, readyAt: receipt.createdAt });
  const ready = await tx.query(`UPDATE unfurl.course_versions SET state='ready',lesson_ids=$2,validation_receipt_id=$3,cover=$4,ready_at=$5
    WHERE id=$1 AND source_run_id=$6 AND state IN ('building','validating') RETURNING id`, [version.id, version.lessonIds, receiptId, JSON.stringify(cover), receipt.createdAt, binding.run.id]);
  if (ready.rows.length !== 1) return invalid();
  await tx.query(`UPDATE unfurl.courses SET current_ready_version_id=$2,cover=$3,title=$4,summary=$5,content_language=$6,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$7`,
    [binding.course.id, version.id, JSON.stringify(cover), version.title, version.summary, version.contentLanguage, binding.course.ownerId]);
  await context.emitGeneration(tx, { type: "generation.validation.summary", summary: { checked: proofIds.length + modules.length + 1, passed: proofIds.length + modules.length + 1, failed: 0,
    categories: ["structure", "sources", "coverage", "answer_separation", "assessment", "content_review"] } });
  await context.completeGeneration(tx, { courseVersionId: version.id });
}
