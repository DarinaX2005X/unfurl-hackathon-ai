import "server-only";
import { z } from "zod";
import { CourseVersionSchema, CurriculumDraftSchema, type CourseVersion, type CurriculumDraft } from "@/domain/course";
import { DigestSchema, IdSchema } from "@/domain/common";
import type { DbTransaction } from "@/server/db";
import { loadStoppedBuildForRelease, type ApprovedBuildBinding } from "@/server/curricula/build-binding";
import { CompletedModuleCheckpointSchema, type CompletedModuleCheckpoint } from "@/server/course-generation/completion";
import { loadGenerationStep } from "@/server/course-generation/repository";
import { loadVerifiedModule } from "./course";
import { mergeOutcomeCoverage, validateCourseCoverage } from "@/server/course-validation/coverage";
import { validateAdaptiveMaterial } from "@/server/course-validation/adaptive-material";
import { TaskValidationRepository, type StoredTaskValidationProof } from "@/server/course-validation/receipts";
import { materializeValidatedTask } from "@/server/mechanics/materialization";
import type { MechanicRuntimeCapabilities } from "@/server/mechanics/contracts";
import { taskDigest } from "@/server/mechanics/digest";
import { createNormalProgramEntries } from "@/server/learning/initial-route";
import { stableExecutionId } from "@/server/runs/identity";
import { OfficialPreviewMetadataSchema, previewFromVersion } from "./preview-metadata";
import { courseVersionFromRow } from "@/server/catalog/projections";

export const OfficialPreviewInputSchema = z.object({
  runId: IdSchema, ownerId: IdSchema, completedStepId: IdSchema,
  applyDigest: DigestSchema.optional(),
}).strict();
export type OfficialPreviewInput = z.infer<typeof OfficialPreviewInputSchema>;
const reject = (reason: string): never => { throw new Error(`Course preview rejected: ${reason}`); };

/** Derives a learning scope, never a replacement approval or edited checkpoint. */
export function firstSectionScope(draft: CurriculumDraft, module: CompletedModuleCheckpoint) {
  const first = draft.modules[0];
  if (draft.modules.length < 2 || !first || first.id !== module.module.moduleId || first.prerequisiteModuleIds.length) return reject("first section is not independent");
  const outcomeIds = new Set(first.outcomeIds);
  const outcomes = draft.outcomes.filter(({ id }) => outcomeIds.has(id));
  if (outcomes.length !== outcomeIds.size || outcomes.some(({ prerequisiteOutcomeIds }) => prerequisiteOutcomeIds.some((id) => !outcomeIds.has(id)))) return reject("section outcomes require unavailable prerequisites");
  return CurriculumDraftSchema.parse({ ...draft, modules: [first], outcomes });
}

function previewReport(binding: Pick<ApprovedBuildBinding, "run" | "course" | "version">, metadata: z.infer<typeof OfficialPreviewMetadataSchema>, applied: boolean, alreadyReleased: boolean) {
  return { kind: "official-course-release", applied, alreadyReleased, inferenceCalls: 0,
    runId: binding.run.id, sourceRunStatus: binding.run.status, courseId: binding.course.id, courseVersionId: binding.version.id,
    coursePath: `/courses/${binding.course.slug}`, publisher: metadata.publisher, releaseDigest: metadata.releaseDigest,
    availableModuleIds: metadata.presentation.availableModuleIds, plannedModuleCount: metadata.presentation.plannedModules.length,
    lessonCount: metadata.presentation.lessons.length, taskCount: metadata.presentation.lessons.reduce((total, lesson) => total + lesson.tasks.length, 0),
    title: binding.version.title, notice: metadata.presentation.notice };
}

/** Caller owns a READ ONLY preview or write transaction. This function never invokes a provider. */
export async function releaseOfficialFirstSection(tx: DbTransaction, raw: OfficialPreviewInput, runtime: MechanicRuntimeCapabilities) {
  const input = OfficialPreviewInputSchema.parse(raw), apply = input.applyDigest !== undefined;
  // Idempotent recovery after an ambiguous commit does not change publication or generation state.
  const existing = (await tx.query(`SELECT v.*, c.slug, c.owner_id, c.visibility, c.published_version_id, r.status AS source_status
    FROM unfurl.course_versions v JOIN unfurl.courses c ON c.id=v.course_id
    JOIN unfurl.generation_runs r ON r.id=v.source_run_id
    WHERE v.source_run_id=$1 AND c.owner_id=$2`, [input.runId, input.ownerId])).rows;
  if (existing.length !== 1) return reject("source version is not unique");
  const existingRow = existing[0]!;
  if (existingRow.release_metadata) {
    const version = courseVersionFromRow(existingRow), metadata = previewFromVersion(existingRow.release_metadata, version)!;
    if (metadata.kind !== "official-section-preview-v1" || version.state !== "ready" || metadata.completedStepId !== input.completedStepId || existingRow.visibility !== "public"
      || existingRow.published_version_id !== version.id || input.applyDigest && input.applyDigest !== metadata.releaseDigest) return reject("existing release differs");
    return previewReport({ run: { id: input.runId, status: existingRow.source_status }, course: { id: version.courseId, slug: existingRow.slug }, version } as Pick<ApprovedBuildBinding, "run" | "course" | "version">, metadata, apply, true);
  }
  const binding = await loadStoppedBuildForRelease(tx, { runId: input.runId, ownerId: input.ownerId, lock: apply });
  if (binding.run.outputVersionId !== null || binding.course.currentReadyVersionId !== null || binding.course.publishedVersionId !== null) return reject("course already has released content");
  const jobs = (await tx.query<{ id: string; status: string }>(`SELECT id,status FROM unfurl.execution_jobs
    WHERE generation_run_id=$1 ${apply ? "FOR UPDATE" : ""}`, [binding.run.id])).rows;
  if (jobs.length !== 1 || !["failed", "cancelled"].includes(jobs[0]!.status)) return reject("generation job has not stopped");
  const busy = (await tx.query(`SELECT id FROM unfurl.generation_runs WHERE course_id=$1 AND status IN ('queued','running','awaiting_user')
    UNION ALL SELECT id FROM unfurl.run_steps WHERE job_id=$2 AND status IN ('pending','running') LIMIT 1`, [binding.course.id, jobs[0]!.id])).rows;
  if (busy.length) return reject("course still has active work");
  const sourceStep = (await tx.query(`SELECT id FROM unfurl.run_steps WHERE id=$1 AND job_id=$2 AND status='succeeded'
    AND result_reference->>'kind'='course.module.completed'`, [input.completedStepId, jobs[0]!.id])).rows[0];
  if (!sourceStep) return reject("the exact completed section is not saved");
  const step = await loadGenerationStep(tx, binding, input.completedStepId, CompletedModuleCheckpointSchema);
  const proofs: StoredTaskValidationProof[] = [];
  const completed = await loadVerifiedModule(tx, binding, step, runtime, (proof) => proofs.push(proof));
  const scopedDraft = firstSectionScope(binding.draft, completed);
  const prepared = completed.module, coverage = mergeOutcomeCoverage(completed.coverage);
  const issues = validateCourseCoverage({ draft: scopedDraft, approvalDigest: binding.approval.contentDigest,
    courseVersionId: binding.version.id, modules: [prepared], coverage });
  if (issues.length || validateAdaptiveMaterial([prepared]).length) return reject("section does not pass complete scoped coverage");
  const lessons = prepared.lessons, tasks = prepared.tasks;
  const version: CourseVersion = CourseVersionSchema.parse({ ...binding.version, state: "validating",
    summary: scopedDraft.modules[0]!.summary, outcomes: scopedDraft.outcomes, modules: scopedDraft.modules,
    lessonIds: lessons.map(({ id }) => id) });
  createNormalProgramEntries({ version, lessons, tasks: tasks.map(({ candidate }) => ({ task: candidate.task, assessment: candidate.privateTask.assessment })) });
  const body = { kind: "official-section-preview-v1" as const, publisher: "Unfurl" as const,
    sourceRunId: binding.run.id, approvalId: binding.approval.id, approvalDigest: binding.approval.contentDigest,
    courseVersionId: version.id, completedStepId: input.completedStepId, moduleDigest: prepared.moduleDigest,
    presentation: { kind: "preview" as const, availableModuleIds: [prepared.moduleId], plannedModules: binding.draft.modules,
      notice: "The first section is available to study. The rest of the curriculum is planned.",
      lessons: lessons.map((lesson) => ({ id: lesson.id, moduleId: lesson.moduleId, title: lesson.title,
        tasks: lesson.taskIds.map((id) => { const task = tasks.find(({ candidate }) => candidate.task.id === id)?.candidate.task;
          if (!task) return reject("lesson task is absent"); return { id: task.id, instruction: task.instruction, mechanicId: task.mechanicId }; }) })) } };
  const metadata = OfficialPreviewMetadataSchema.parse({ ...body, releaseDigest: taskDigest(body) });
  // Preview verifies stored task receipts and current runtime readiness without persisting them.
  const validation = new TaskValidationRepository();
  if (proofs.length !== tasks.length || proofs.some((proof) => !tasks.some(({ candidate }) => taskDigest(candidate) === taskDigest(proof.candidate)))) return reject("task evidence failed revalidation");
  if (!apply) return previewReport(binding, metadata, false, false);
  if (metadata.releaseDigest !== input.applyDigest) return reject("approved preview changed");
  for (const lesson of lessons) await tx.query(`INSERT INTO unfurl.lessons(id,course_version_id,module_id,title,outcome_ids,blocks,task_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [lesson.id, version.id, lesson.moduleId, lesson.title, lesson.outcomeIds, JSON.stringify(lesson.blocks), lesson.taskIds]);
  const proofIds: string[] = [];
  for (const proof of proofs) {
    const task = proof.candidate.task;
    await tx.query(`INSERT INTO unfurl.tasks_public(id,task_version,course_version_id,mechanic_id,mechanic_version,outcome_ids,instruction,content_language,config,available_hints,response_schema_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [task.id, task.taskVersion, version.id, task.mechanicId, task.mechanicVersion, task.outcomeIds, task.instruction, task.contentLanguage, JSON.stringify(task.config), task.availableHints, task.responseSchemaVersion]);
    const receipt = await validation.persistReceipt(tx, proof);
    const { privateTask } = materializeValidatedTask(proof.candidate, { runtime, receipt });
    await tx.query(`INSERT INTO unfurl.tasks_private(task_id,task_version,evaluation_spec,source_claim_ids,validation_receipt_id,hints,worked_example,evaluator_data,assessment)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [task.id, task.taskVersion, JSON.stringify(privateTask.evaluationSpec), privateTask.sourceClaimIds, receipt.id, JSON.stringify(privateTask.hints), JSON.stringify(privateTask.workedExample), JSON.stringify(privateTask.evaluatorData), JSON.stringify(privateTask.assessment)]);
    proofIds.push(receipt.id);
  }
  const receiptId = stableExecutionId(version.id, "official-section-preview-v1"), now = new Date().toISOString();
  const receipt = { id: receiptId, courseVersionId: version.id, approvalDigest: binding.approval.contentDigest,
    contentDigest: metadata.releaseDigest, verdict: "passed", validatorVersion: "official-section-preview-v1",
    sourceRunId: binding.run.id, completedStepId: input.completedStepId, moduleDigests: [{ moduleId: prepared.moduleId, digest: prepared.moduleDigest }],
    scope: { kind: "first-section", availableModuleIds: metadata.presentation.availableModuleIds, plannedModuleCount: binding.draft.modules.length },
    taskReceiptIds: proofIds, reviewStepIds: [completed.reviewStepId], coverage,
    normalRouteValidated: true, adaptiveMaterialValidated: true, createdAt: now };
  await tx.query("INSERT INTO unfurl.version_validation_receipts(id,course_version_id,verdict,document) VALUES($1,$2,'passed',$3)", [receiptId, version.id, JSON.stringify(receipt)]);
  const cover = { motifId: "learning-path", alt: version.title };
  CourseVersionSchema.parse({ ...version, state: "ready", validationReceiptId: receiptId, cover, readyAt: now });
  const saved = await tx.query(`UPDATE unfurl.course_versions SET state='ready',summary=$2,outcomes=$3,modules=$4,lesson_ids=$5,
    validation_receipt_id=$6,cover=$7,ready_at=$8,release_metadata=$9 WHERE id=$1 AND state='failed' AND source_run_id=$10 AND release_metadata IS NULL RETURNING id`,
    [version.id, version.summary, JSON.stringify(version.outcomes), JSON.stringify(version.modules), version.lessonIds, receiptId, JSON.stringify(cover), now, JSON.stringify(metadata), binding.run.id]);
  if (saved.rows.length !== 1) return reject("source version changed");
  await tx.query(`UPDATE unfurl.courses SET current_ready_version_id=$2,published_version_id=$2,visibility='public',cover=$3,
    summary=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$5`, [binding.course.id, version.id, JSON.stringify(cover), version.summary, input.ownerId]);
  // Original run, approved curriculum, checkpoints, source records and XP are deliberately untouched.
  return previewReport(binding, metadata, true, false);
}
