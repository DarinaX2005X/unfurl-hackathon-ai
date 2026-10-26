import "server-only";
import { assertCurrentApproval, curriculumDigest, CurriculumDraftSchema,
  type Course, type CourseVersion, type CurriculumApproval, type CurriculumDraft } from "../../domain/course";
import type { GenerationRun } from "../../domain/generation";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";
import { PostgresCurriculumResearchRepository } from "../curriculum-research/repository";
import type { CurriculumResearchEvidence } from "../curriculum-research/contracts";
import { validateCurriculumEvidence, type CurriculumEvidenceFacts } from "../curriculum-research/validation";
import { approvalFromRow, generationFromRow, requireCourse, requireDraft, versionFromRow,
  type ApprovalRow, type GenerationRow, type VersionRow } from "./repository";
import { validateCurriculumOrder } from "./changes";

export interface ApprovedBuildBinding {
  run: GenerationRun; course: Course; version: CourseVersion; approval: CurriculumApproval; draft: CurriculumDraft;
  evidence: CurriculumResearchEvidence; facts: CurriculumEvidenceFacts;
}
const unavailableBinding = () => new ServiceFault(409, "revision_conflict", "generation.approvalUnavailable");

/** Storage is the only input authority. Call inside ctx.read or the guarded step commit transaction. */
export async function loadApprovedBuild(tx: DbTransaction, input: {
  runId: string; ownerId?: string; lock?: boolean;
}): Promise<ApprovedBuildBinding> {
  return loadBuildBinding(tx, input, false);
}

/** Explicit release operator only. A stopped build remains stopped; no execution is resumed. */
export async function loadStoppedBuildForRelease(tx: DbTransaction, input: {
  runId: string; ownerId: string; lock?: boolean;
}): Promise<ApprovedBuildBinding> {
  return loadBuildBinding(tx, input, true);
}

async function loadBuildBinding(tx: DbTransaction, input: {
  runId: string; ownerId?: string; lock?: boolean;
}, stoppedRelease: boolean): Promise<ApprovedBuildBinding> {
  let row = (await tx.query<GenerationRow>("SELECT * FROM unfurl.generation_runs WHERE id=$1", [input.runId])).rows[0];
  if (!row || !row.course_id || !row.approval_id || (input.ownerId !== undefined && row.owner_id !== input.ownerId)) {
    throw new ServiceFault(404, "not_found", "generation.notFound");
  }
  const course = await requireCourse(tx, row.owner_id, row.course_id, input.lock);
  const approvalRow = (await tx.query<ApprovalRow>("SELECT * FROM unfurl.curriculum_approvals WHERE id=$1 AND approved_by=$2", [row.approval_id, course.ownerId])).rows[0];
  if (!approvalRow) throw unavailableBinding();
  const approval = approvalFromRow(approvalRow);
  const current = await requireDraft(tx, course.ownerId, approval.draftId, input.lock);
  if (input.lock) row = (await tx.query<GenerationRow>("SELECT * FROM unfurl.generation_runs WHERE id=$1 FOR UPDATE", [input.runId])).rows[0]!;
  const run = generationFromRow(row);
  const conversation = (await tx.query<{ id: string }>(`SELECT id FROM unfurl.conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`, [run.conversationId, course.ownerId])).rows[0];
  if (!conversation || !(stoppedRelease ? ["failed", "cancelled"] : ["queued", "running"]).includes(run.status) || run.courseId !== course.id || run.ownerId !== course.ownerId
    || run.approvalId !== approval.id || run.sourceDraftRevision !== approval.draftRevision || current.draft.revision !== approval.draftRevision
    || current.draft.conversationId !== run.conversationId) throw unavailableBinding();
  const revision = (await tx.query<{ document: unknown; content_digest: string }>(`SELECT document,content_digest FROM unfurl.curriculum_revisions
    WHERE draft_id=$1 AND revision=$2 AND content_digest=$3`, [approval.draftId, approval.draftRevision, approval.contentDigest])).rows[0];
  if (!revision) throw unavailableBinding();
  const draft = CurriculumDraftSchema.parse(revision.document);
  if (draft.id !== approval.draftId || draft.courseId !== course.id || draft.revision !== approval.draftRevision
    || await curriculumDigest(current.draft) !== revision.content_digest || validateCurriculumOrder(draft).length) throw unavailableBinding();
  await assertCurrentApproval(draft, approval);
  const versionRow = (await tx.query<VersionRow>(`SELECT * FROM unfurl.course_versions
    WHERE source_run_id=$1 AND approval_id=$2 AND course_id=$3 ${input.lock ? "FOR UPDATE" : ""}`, [run.id, approval.id, course.id])).rows[0];
  if (!versionRow) throw unavailableBinding();
  const version = versionFromRow(versionRow);
  if (!(stoppedRelease ? ["failed"] : ["building", "validating"]).includes(version.state) || version.contentDigest !== approval.contentDigest
    || version.contentLanguage !== draft.contentLanguage || version.title !== draft.title
    || JSON.stringify(version.outcomes) !== JSON.stringify(draft.outcomes) || JSON.stringify(version.modules) !== JSON.stringify(draft.modules)
    || JSON.stringify(version.assumedKnowledge) !== JSON.stringify(draft.assumedKnowledge)) throw unavailableBinding();
  const research = await new PostgresCurriculumResearchRepository().loadEvidence(tx, { draft, ownerId: course.ownerId });
  if ((await validateCurriculumEvidence(draft, research.evidence, research.facts)).length) throw unavailableBinding();
  return { run, course, version, approval, draft, ...research };
}
