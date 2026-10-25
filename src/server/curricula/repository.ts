import "server-only";
import { randomUUID } from "node:crypto";
import type { DbTransaction } from "../db";
import { ServiceFault } from "../auth/errors";
import { CourseSchema, CourseVersionSchema, CurriculumApprovalSchema, CurriculumDraftSchema, curriculumDigest,
  type Course, type CourseVersion, type CurriculumApproval, type CurriculumDraft } from "../../domain/course";
import { CourseArtifactRefSchema, type CourseArtifactRef } from "../../domain/chat";
import { AgentTurnRunSchema, GenerationRunSchema, type AgentTurnRun, type GenerationRun } from "../../domain/generation";
import { CurriculumMutationResultSchema, type CurriculumMutationResult } from "../../domain/curriculum-authoring";
import { PostgresCurriculumResearchRepository } from "../curriculum-research/repository";
import type { CurriculumResearchEvidence } from "../curriculum-research/contracts";
import { validateCurriculumEvidence, type CurriculumEvidenceFacts } from "../curriculum-research/validation";
import { cancelGenerationInTransaction, enqueueAcceptedRun } from "../runs/enqueue";
import { validateCurriculumOrder } from "./changes";

type DateValue = Date | string;
export interface CourseRow { id: string; owner_id: string; slug: string; title: string; summary: string; content_language: string;
  visibility: string; current_ready_version_id: string | null; published_version_id: string | null;
  revision: number; created_at: DateValue; updated_at: DateValue }
export interface ApprovalRow { id: string; draft_id: string; draft_revision: number; content_digest: string; approved_by: string; approved_at: DateValue }
export interface GenerationRow { id: string; owner_id: string; course_id: string | null; conversation_id: string; branch_id: string;
  input_message_id: string; source_draft_revision: number | null; approval_id: string | null; phase: string; status: string;
  last_seq: number; output_version_id: string | null; error: unknown; created_at: DateValue; updated_at: DateValue }
export interface VersionRow { id: string; course_id: string; number: number; approval_id: string; source_run_id: string; content_digest: string;
  state: string; title: string; summary: string; content_language: string; assumed_knowledge: unknown; outcomes: unknown; modules: unknown;
  lesson_ids: string[]; validation_receipt_id: string | null; cover: unknown; created_at: DateValue; ready_at: DateValue | null }
interface TurnRow { id: string; owner_id: string; conversation_id: string; branch_id: string; input_message_id: string;
  status: string; last_seq: number; error: unknown; created_at: DateValue; updated_at: DateValue }
export const iso = (value: DateValue): string => new Date(value).toISOString();
export const missingCurriculum = () => new ServiceFault(404, "not_found", "curriculum.notFound");
export const curriculumConflict = (revision: number) => new ServiceFault(409, "revision_conflict", "curriculum.changed", false, { currentRevision: revision });
export const invalidCurriculum = () => new ServiceFault(400, "invalid_input", "curriculum.invalid");
export const researchRequired = (revision: number) => new ServiceFault(409, "revision_conflict", "curriculum.researchRequired", false, { currentRevision: revision });

export function courseFromRow(row: CourseRow): Course {
  return CourseSchema.parse({ id: row.id, ownerId: row.owner_id, slug: row.slug, title: row.title, summary: row.summary,
    contentLanguage: row.content_language, visibility: row.visibility, currentReadyVersionId: row.current_ready_version_id,
    publishedVersionId: row.published_version_id, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
export function approvalFromRow(row: ApprovalRow): CurriculumApproval {
  return CurriculumApprovalSchema.parse({ id: row.id, draftId: row.draft_id, draftRevision: row.draft_revision,
    contentDigest: row.content_digest, approvedBy: row.approved_by, approvedAt: iso(row.approved_at) });
}
export function generationFromRow(row: GenerationRow): GenerationRun {
  return GenerationRunSchema.parse({ id: row.id, ownerId: row.owner_id, courseId: row.course_id, conversationId: row.conversation_id,
    branchId: row.branch_id, inputMessageId: row.input_message_id, sourceDraftRevision: row.source_draft_revision,
    approvalId: row.approval_id, phase: row.phase, status: row.status, lastSeq: row.last_seq, outputVersionId: row.output_version_id,
    error: row.error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
export function versionFromRow(row: VersionRow): CourseVersion {
  return CourseVersionSchema.parse({ id: row.id, courseId: row.course_id, number: row.number, approvalId: row.approval_id,
    sourceRunId: row.source_run_id, contentDigest: row.content_digest, state: row.state, title: row.title, summary: row.summary,
    contentLanguage: row.content_language, assumedKnowledge: row.assumed_knowledge, outcomes: row.outcomes, modules: row.modules,
    lessonIds: row.lesson_ids, validationReceiptId: row.validation_receipt_id, cover: row.cover,
    createdAt: iso(row.created_at), readyAt: row.ready_at ? iso(row.ready_at) : null });
}
export function turnFromRow(row: TurnRow): AgentTurnRun {
  return AgentTurnRunSchema.parse({ id: row.id, ownerId: row.owner_id, conversationId: row.conversation_id, branchId: row.branch_id,
    inputMessageId: row.input_message_id, status: row.status, lastSeq: row.last_seq, error: row.error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}

export async function requireCourse(tx: DbTransaction, ownerId: string, courseId: string, lock = false): Promise<Course> {
  const row = (await tx.query<CourseRow>(`SELECT * FROM unfurl.courses WHERE id=$1 AND owner_id=$2 ${lock ? "FOR UPDATE" : ""}`, [courseId, ownerId])).rows[0];
  if (!row || row.owner_id !== ownerId) throw missingCurriculum();
  return courseFromRow(row);
}
export async function requireDraft(tx: DbTransaction, ownerId: string, draftId: string, lock = false): Promise<{ course: Course; draft: CurriculumDraft }> {
  const identity = (await tx.query<{ course_id: string }>(`SELECT d.course_id FROM unfurl.curriculum_drafts d
    JOIN unfurl.courses c ON c.id=d.course_id WHERE d.id=$1 AND c.owner_id=$2`, [draftId, ownerId])).rows[0];
  if (!identity) throw missingCurriculum();
  const course = await requireCourse(tx, ownerId, identity.course_id, lock);
  const row = (await tx.query<{ document: unknown; revision: number }>(`SELECT document,revision FROM unfurl.curriculum_drafts WHERE id=$1 AND course_id=$2 ${lock ? "FOR UPDATE" : ""}`, [draftId, course.id])).rows[0];
  if (!row) throw missingCurriculum();
  const draft = CurriculumDraftSchema.parse(row.document);
  if (draft.id !== draftId || draft.courseId !== course.id || draft.revision !== row.revision) throw invalidCurriculum();
  return { course, draft };
}
export async function requireCourseDraft(tx: DbTransaction, ownerId: string, courseId: string, lock = false) {
  const course = await requireCourse(tx, ownerId, courseId, lock);
  const row = (await tx.query<{ id: string }>("SELECT id FROM unfurl.curriculum_drafts WHERE course_id=$1", [course.id])).rows[0];
  if (!row) throw missingCurriculum();
  return requireDraft(tx, ownerId, row.id, lock);
}
export async function requireAuthoringConversation(tx: DbTransaction, ownerId: string, draft: CurriculumDraft, lock: "share" | "update" = "share"): Promise<{ branchId: string; inputMessageId: string }> {
  const row = (await tx.query<{ active_branch_id: string; input_message_id: string | null }>(`SELECT c.active_branch_id,
    (SELECT m.id FROM unfurl.messages m WHERE m.conversation_id=c.id AND m.branch_id=c.active_branch_id AND m.role='user' AND m.status='complete'
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS input_message_id
    FROM unfurl.conversations c WHERE c.id=$1 AND c.owner_id=$2 AND c.deleted_at IS NULL ${lock === "update" ? "FOR UPDATE" : "FOR SHARE"} OF c`, [draft.conversationId, ownerId])).rows[0];
  if (!row?.input_message_id) throw missingCurriculum();
  return { branchId: row.active_branch_id, inputMessageId: row.input_message_id };
}
export async function readArtifact(tx: DbTransaction, ownerId: string, courseId: string): Promise<CourseArtifactRef> {
  const { course, draft } = await requireCourseDraft(tx, ownerId, courseId);
  const digest = await curriculumDigest(draft);
  const row = (await tx.query<ApprovalRow>(`SELECT * FROM unfurl.curriculum_approvals
    WHERE draft_id=$1 AND draft_revision=$2 AND content_digest=$3 AND approved_by=$4`, [draft.id, draft.revision, digest, ownerId])).rows[0];
  const request = (await tx.query<{ approval_requested_revision: number | null }>("SELECT approval_requested_revision FROM unfurl.curriculum_drafts WHERE id=$1", [draft.id])).rows[0];
  return CourseArtifactRefSchema.parse({ courseId: course.id, title: course.title, summary: course.summary, contentLanguage: course.contentLanguage,
    revision: course.revision, curriculum: draft, approval: row ? approvalFromRow(row) : null, approvalRequestedRevision: request?.approval_requested_revision ?? null,
    readyVersionId: course.currentReadyVersionId, updatedAt: course.updatedAt > draft.updatedAt ? course.updatedAt : draft.updatedAt });
}
export async function readCurrentRuns(tx: DbTransaction, ownerId: string, artifact: CourseArtifactRef): Promise<{ generationRun: GenerationRun | null; languageRun: AgentTurnRun | null }> {
  const draft = artifact.curriculum;
  let generationRun: GenerationRun | null = null;
  if (draft && artifact.approval) {
    const row = (await tx.query<GenerationRow>(`SELECT * FROM unfurl.generation_runs
      WHERE owner_id=$1 AND course_id=$2 AND approval_id=$3 AND source_draft_revision=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ownerId, artifact.courseId, artifact.approval.id, draft.revision])).rows[0];
    if (row) generationRun = generationFromRow(row);
  }
  const language = (await tx.query<TurnRow>(`SELECT r.* FROM unfurl.course_language_revision_intents intent
    JOIN unfurl.agent_turn_runs r ON r.id=intent.run_id AND r.owner_id=intent.owner_id
    WHERE intent.owner_id=$1 AND intent.course_id=$2 ORDER BY intent.created_at DESC,intent.run_id DESC LIMIT 1`, [ownerId, artifact.courseId])).rows[0];
  return { generationRun, languageRun: language ? turnFromRow(language) : null };
}

export async function mutationResult(tx: DbTransaction, ownerId: string, courseId: string): Promise<CurriculumMutationResult> {
  const artifact = await readArtifact(tx, ownerId, courseId);
  if (!artifact.curriculum) throw missingCurriculum();
  return CurriculumMutationResultSchema.parse({ draft: artifact.curriculum, contentDigest: await curriculumDigest(artifact.curriculum), artifact });
}
export async function cancelAffectedBuilds(tx: DbTransaction, ownerId: string, draft: CurriculumDraft): Promise<void> {
  const rows = (await tx.query<{ id: string }>(`SELECT r.id FROM unfurl.generation_runs r JOIN unfurl.curriculum_approvals a ON a.id=r.approval_id
    WHERE r.owner_id=$1 AND r.course_id=$2 AND a.draft_id=$3 AND a.draft_revision=$4 AND r.status IN ('queued','running','awaiting_user')
    ORDER BY r.id`, [ownerId, draft.courseId, draft.id, draft.revision])).rows;
  for (const row of rows) await cancelGenerationInTransaction(tx, { runId: row.id, ownerId, reason: "superseded" });
}
export async function saveDraftRevision(tx: DbTransaction, input: {
  ownerId: string; previous: CurriculumDraft; next: CurriculumDraft; evidence: CurriculumResearchEvidence | null; approvalReady?: boolean;
}): Promise<void> {
  const { previous, next, ownerId } = input;
  const current = await requireDraft(tx, ownerId, previous.id, true);
  if (current.draft.revision !== previous.revision || await curriculumDigest(current.draft) !== await curriculumDigest(previous)) throw curriculumConflict(current.draft.revision);
  if (next.id !== previous.id || next.courseId !== previous.courseId || next.conversationId !== previous.conversationId
    || next.revision !== previous.revision + 1 || validateCurriculumOrder(next).length) throw invalidCurriculum();
  await cancelAffectedBuilds(tx, ownerId, previous);
  const canRequestApproval = input.approvalReady === true && input.evidence !== null && !next.unresolvedQuestions.some((question) => question.blocking);
  const updated = await tx.query(`UPDATE unfurl.curriculum_drafts SET revision=$3,document=$4,approval_requested_revision=$6,updated_at=$5
    WHERE id=$1 AND revision=$2`, [previous.id, previous.revision, next.revision, JSON.stringify(next), next.updatedAt, canRequestApproval ? next.revision : null]);
  if (updated.rowCount !== 1) throw curriculumConflict(previous.revision);
  const digest = await curriculumDigest(next);
  await tx.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,$2,$3,$4)", [next.id, next.revision, digest, JSON.stringify(next)]);
  if (input.evidence) await new PostgresCurriculumResearchRepository().saveEvidence(tx, { draftId: next.id, revision: next.revision, evidence: input.evidence });
  await tx.query("UPDATE unfurl.courses SET title=$3,revision=revision+1,updated_at=$4 WHERE id=$1 AND owner_id=$2", [next.courseId, ownerId, next.title, next.updatedAt]);
}

/** Called only inside a guarded tool step; the step receipt/events commit in the same outer transaction. */
export async function createResearchedCourse(tx: DbTransaction, input: {
  ownerId: string; runId: string; branchId: string; courseId: string; summary: string; draft: CurriculumDraft;
  evidence: CurriculumResearchEvidence; facts: CurriculumEvidenceFacts;
}): Promise<CurriculumMutationResult> {
  const draft = CurriculumDraftSchema.parse(input.draft);
  const run = (await tx.query<{ id: string }>(`SELECT r.id FROM unfurl.agent_turn_runs r JOIN unfurl.conversations c ON c.id=r.conversation_id
    WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3 AND r.branch_id=$4 AND c.owner_id=r.owner_id
    AND c.active_branch_id=r.branch_id AND c.deleted_at IS NULL AND r.status IN ('queued','running')`,
  [input.runId, input.ownerId, draft.conversationId, input.branchId])).rows[0];
  if (!run || draft.courseId !== input.courseId || draft.revision !== 1 || input.facts.ownerId !== input.ownerId) throw missingCurriculum();
  if (validateCurriculumOrder(draft).length) throw invalidCurriculum();
  const issues = await validateCurriculumEvidence(draft, input.evidence, input.facts);
  if (issues.some((issue) => !["blocking_question", "unresolved_conflict"].includes(issue.code))) throw researchRequired(draft.revision);
  const slug = `${draft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "course"}-${input.courseId}`;
  const course = CourseSchema.parse({ id: input.courseId, ownerId: input.ownerId, slug, title: draft.title, summary: input.summary,
    contentLanguage: draft.contentLanguage, visibility: "private", currentReadyVersionId: null, publishedVersionId: null,
    revision: 1, createdAt: draft.updatedAt, updatedAt: draft.updatedAt });
  await tx.query(`INSERT INTO unfurl.courses(id,owner_id,slug,title,summary,content_language,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, [course.id, course.ownerId, course.slug, course.title, course.summary, course.contentLanguage, course.createdAt]);
  await tx.query(`INSERT INTO unfurl.curriculum_drafts(id,course_id,conversation_id,revision,document,approval_requested_revision,updated_at)
    VALUES($1,$2,$3,1,$4,$6,$5)`, [draft.id, course.id, draft.conversationId, JSON.stringify(draft), draft.updatedAt, issues.length === 0 ? 1 : null]);
  await tx.query("INSERT INTO unfurl.curriculum_revisions(draft_id,revision,content_digest,document) VALUES($1,1,$2,$3)", [draft.id, await curriculumDigest(draft), JSON.stringify(draft)]);
  await new PostgresCurriculumResearchRepository().saveEvidence(tx, { draftId: draft.id, revision: 1, evidence: input.evidence });
  const persistedResearch = await new PostgresCurriculumResearchRepository().loadEvidence(tx, { draft, ownerId: input.ownerId });
  if ((await validateCurriculumEvidence(draft, persistedResearch.evidence, persistedResearch.facts))
    .some((issue) => !["blocking_question", "unresolved_conflict"].includes(issue.code))) throw researchRequired(draft.revision);
  await tx.query("INSERT INTO unfurl.conversation_artifacts(conversation_id,course_id) VALUES($1,$2)", [draft.conversationId, course.id]);
  return mutationResult(tx, input.ownerId, course.id);
}

export async function approveInTransaction(tx: DbTransaction, input: { ownerId: string; draftId: string; expectedRevision: number; contentDigest: string }) {
  const { course, draft } = await requireDraft(tx, input.ownerId, input.draftId, true);
  const digest = await curriculumDigest(draft);
  if (draft.revision !== input.expectedRevision || digest !== input.contentDigest) throw curriculumConflict(draft.revision);
  if (validateCurriculumOrder(draft).length) throw invalidCurriculum();
  const research = await new PostgresCurriculumResearchRepository().loadEvidence(tx, { draft, ownerId: input.ownerId });
  if ((await validateCurriculumEvidence(draft, research.evidence, research.facts)).length) throw researchRequired(draft.revision);
  const conversation = await requireAuthoringConversation(tx, input.ownerId, draft);
  let approvalRow = (await tx.query<ApprovalRow>(`SELECT * FROM unfurl.curriculum_approvals
    WHERE draft_id=$1 AND draft_revision=$2 AND content_digest=$3 AND approved_by=$4`, [draft.id, draft.revision, digest, input.ownerId])).rows[0];
  if (!approvalRow) approvalRow = (await tx.query<ApprovalRow>(`INSERT INTO unfurl.curriculum_approvals(id,draft_id,draft_revision,content_digest,approved_by)
    VALUES($1,$2,$3,$4,$5) RETURNING *`, [randomUUID(), draft.id, draft.revision, digest, input.ownerId])).rows[0]!;
  const approval = approvalFromRow(approvalRow);
  let row = (await tx.query<GenerationRow>("SELECT * FROM unfurl.generation_runs WHERE approval_id=$1 AND retry_of_run_id IS NULL", [approval.id])).rows[0];
  if (!row) {
    const runId = randomUUID();
    row = (await tx.query<GenerationRow>(`INSERT INTO unfurl.generation_runs
      (id,owner_id,course_id,conversation_id,branch_id,input_message_id,source_draft_revision,approval_id,phase,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'module_research','queued') RETURNING *`,
    [runId, input.ownerId, course.id, draft.conversationId, conversation.branchId, conversation.inputMessageId, draft.revision, approval.id])).rows[0]!;
    const nextNumber = (await tx.query<{ number: number }>("SELECT COALESCE(max(number),0)+1 AS number FROM unfurl.course_versions WHERE course_id=$1", [course.id])).rows[0]!.number;
    await tx.query(`INSERT INTO unfurl.course_versions(id,course_id,number,approval_id,source_run_id,content_digest,state,title,summary,content_language,assumed_knowledge,outcomes,modules)
      VALUES($1,$2,$3,$4,$5,$6,'building',$7,$8,$9,$10,$11,$12)`, [randomUUID(), course.id, nextNumber, approval.id, runId, digest,
      draft.title, course.summary, draft.contentLanguage, JSON.stringify(draft.assumedKnowledge), JSON.stringify(draft.outcomes), JSON.stringify(draft.modules)]);
    await enqueueAcceptedRun(tx, { kind: "generation", runId });
    await tx.query("UPDATE unfurl.courses SET revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2", [course.id, input.ownerId]);
    row = (await tx.query<GenerationRow>("SELECT * FROM unfurl.generation_runs WHERE id=$1", [runId])).rows[0]!;
  }
  if (row.owner_id !== input.ownerId || row.course_id !== course.id || row.source_draft_revision !== draft.revision) throw invalidCurriculum();
  return { approval, run: generationFromRow(row), artifact: await readArtifact(tx, input.ownerId, course.id) };
}
