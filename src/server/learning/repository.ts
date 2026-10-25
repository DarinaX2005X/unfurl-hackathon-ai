import "server-only";
import { z } from "zod";
import type { QueryResultRow } from "pg";
import {
  ActivitySessionPublicSchema, InputSnapshotSchema, validateInputSnapshot, type ActivitySessionPublic,
} from "@/domain/activity";
import {
  AssessmentReviewRequestSchema, EnrollmentSchema, EvaluationReceiptSchema, LessonSchema, PersonalRouteSchema,
  SupportOfferSchema, type Enrollment, type EvaluationReceipt, type PersonalRoute, type SupportOffer,
} from "@/domain/learning";
import { TaskAssessmentSchema, TaskPrivateSchema, TaskPublicSchema } from "@/domain/mechanics";
import { ActivityStateSchema, type ActivityState } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { ServiceFault } from "@/server/auth/errors";
import type { DbTransaction } from "@/server/db";
import { courseVersionFromRow } from "@/server/catalog/projections";
import { getServerMechanic } from "@/server/mechanics/registry";
import type { AuthoritativeActivity } from "@/server/evaluation/contracts";
import type { ConfirmableEvidence } from "./evidence";
import type { AssessedTask } from "./initial-route";

export const storedTime = (value: unknown) => z.union([z.date(), z.string()]).transform((date) => new Date(date).toISOString()).parse(value);
export function notFound(): never { throw new ServiceFault(404, "not_found", "learning.notFound"); }
export function invariant(): never { throw new ServiceFault(503, "service_unavailable", "learning.storageInvariant", false); }
export function revisionConflict(revision: number, messageKey = "learning.routeChanged"): never {
  throw new ServiceFault(409, "revision_conflict", messageKey, false, { currentRevision: revision });
}

export async function requireEnrollment(tx: DbTransaction, actor: Actor, id: string, lock = false): Promise<Enrollment> {
  const row = (await tx.query(`SELECT * FROM unfurl.enrollments WHERE id=$1 AND learner_id=$2${lock ? " FOR UPDATE" : ""}`, [id, actor.id])).rows[0];
  if (!row) notFound();
  return enrollmentFromRow(row);
}

export function enrollmentFromRow(row: Record<string, unknown>): Enrollment {
  return EnrollmentSchema.parse({ id: row.id, learnerId: row.learner_id, courseId: row.course_id, courseVersionId: row.course_version_id,
    status: row.status, routeRevision: row.route_revision, currentLessonId: row.current_lesson_id, currentTaskId: row.current_task_id,
    createdAt: storedTime(row.created_at), lastStudiedAt: row.last_studied_at === null ? null : storedTime(row.last_studied_at) });
}

export async function requireRoute(tx: DbTransaction, enrollment: Enrollment): Promise<PersonalRoute> {
  const row = (await tx.query("SELECT revision,document FROM unfurl.personal_routes WHERE enrollment_id=$1", [enrollment.id])).rows[0];
  if (!row) invariant();
  const route = PersonalRouteSchema.parse(row.document);
  const first = route.next[0];
  if (route.enrollmentId !== enrollment.id || route.revision !== row.revision || route.revision !== enrollment.routeRevision ||
    (first?.lessonId ?? null) !== enrollment.currentLessonId || (first?.taskId ?? null) !== enrollment.currentTaskId) invariant();
  return route;
}

export function taskFromRow(row: Record<string, unknown>) {
  const task = TaskPublicSchema.parse({ id: row.id, taskVersion: row.task_version, mechanicId: row.mechanic_id, mechanicVersion: row.mechanic_version,
    outcomeIds: row.outcome_ids, instruction: row.instruction, contentLanguage: row.content_language, config: row.config,
    availableHints: row.available_hints, responseSchemaVersion: row.response_schema_version });
  const handle = getServerMechanic(task.mechanicId, task.mechanicVersion);
  return handle ? handle.parseTask(task) : invariant();
}
export async function loadProgram(tx: DbTransaction, enrollment: Enrollment) {
  const raw = (await tx.query("SELECT * FROM unfurl.course_versions WHERE id=$1 AND course_id=$2 AND state='ready'", [enrollment.courseVersionId, enrollment.courseId])).rows[0];
  if (!raw) invariant();
  const version = courseVersionFromRow(raw);
  const lessons = (await tx.query("SELECT * FROM unfurl.lessons WHERE course_version_id=$1", [version.id])).rows.map((row) => LessonSchema.parse({
    id: row.id, courseVersionId: row.course_version_id, moduleId: row.module_id, title: row.title,
    outcomeIds: row.outcome_ids, blocks: row.blocks, taskIds: row.task_ids }));
  const rows = (await tx.query(`SELECT t.*, p.assessment FROM unfurl.tasks_public t
    JOIN unfurl.tasks_private p ON p.task_id=t.id AND p.task_version=t.task_version
    JOIN unfurl.task_validation_receipts receipt ON receipt.id=p.validation_receipt_id AND receipt.task_id=t.id AND receipt.task_version=t.task_version
    WHERE t.course_version_id=$1 AND receipt.verdict='passed'`, [version.id])).rows;
  const tasks: AssessedTask[] = rows.map((row) => ({ task: taskFromRow(row), assessment: TaskAssessmentSchema.parse(row.assessment) }));
  return { version, lessons, tasks };
}

export async function requireCurrentTask(tx: DbTransaction, enrollment: Enrollment, taskId: string, taskVersion: number) {
  const route = await requireRoute(tx, enrollment);
  if (enrollment.status === "archived" || (enrollment.status === "completed" && route.next[0]?.reasonCode !== "scheduled_review")) revisionConflict(enrollment.routeRevision, "learning.enrollmentInactive");
  if (enrollment.currentTaskId !== taskId || route.next[0]?.taskId !== taskId) revisionConflict(enrollment.routeRevision);
  const program = await loadProgram(tx, enrollment);
  const task = program.tasks.find((entry) => entry.task.id === taskId && entry.task.taskVersion === taskVersion)?.task;
  if (!task || !program.lessons.some((lesson) => lesson.id === enrollment.currentLessonId && lesson.taskIds.includes(task.id))) notFound();
  return task;
}

export async function attemptEnrollmentId(tx: DbTransaction, actor: Actor, attemptId: string): Promise<string> {
  const row = (await tx.query<{ enrollment_id: string }>(`SELECT a.enrollment_id FROM unfurl.attempts a JOIN unfurl.enrollments e
    ON e.id=a.enrollment_id AND e.learner_id=a.learner_id AND e.course_version_id=a.course_version_id
    WHERE a.id=$1 AND a.learner_id=$2`, [attemptId, actor.id])).rows[0];
  return row?.enrollment_id ?? notFound();
}

export async function loadPrivateTask(tx: DbTransaction, enrollment: Enrollment, taskId: string, taskVersion: number) {
  const row = (await tx.query(`SELECT p.* FROM unfurl.tasks_private p JOIN unfurl.tasks_public t ON t.id=p.task_id AND t.task_version=p.task_version
    WHERE t.course_version_id=$1 AND p.task_id=$2 AND p.task_version=$3`, [enrollment.courseVersionId, taskId, taskVersion])).rows[0];
  if (!row) invariant();
  return TaskPrivateSchema.parse({ taskId: row.task_id, taskVersion: row.task_version, evaluationSpec: row.evaluation_spec, evaluatorData: row.evaluator_data,
    assessment: row.assessment, sourceClaimIds: row.source_claim_ids, validationReceiptId: row.validation_receipt_id, hints: row.hints, workedExample: row.worked_example });
}

export async function activityEnrollmentId(tx: DbTransaction, actor: Actor, activityId: string): Promise<string> {
  const row = (await tx.query<{ enrollment_id: string }>(`SELECT s.enrollment_id FROM unfurl.activity_sessions s
    JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE s.id=$1 AND e.learner_id=$2`, [activityId, actor.id])).rows[0];
  return row?.enrollment_id ?? notFound();
}

export async function readActivity(tx: DbTransaction, enrollment: Enrollment, activityId: string, lock = false): Promise<ActivityState> {
  const row = (await tx.query(`SELECT s.* FROM unfurl.activity_sessions s JOIN unfurl.tasks_public t ON t.id=s.task_id AND t.task_version=s.task_version
    WHERE s.id=$1 AND s.enrollment_id=$2 AND t.course_version_id=$3${lock ? " FOR UPDATE OF s" : ""}`, [activityId, enrollment.id, enrollment.courseVersionId])).rows[0];
  if (!row) notFound();
  const actions = (await tx.query(`SELECT id,client_action_id,input_revision,response_digest,session_revision,status,public_observation,action,created_at
    FROM unfurl.activity_actions WHERE activity_session_id=$1 ORDER BY session_revision LIMIT 101`, [activityId])).rows;
  const activity = ActivitySessionPublicSchema.parse({ id: row.id, enrollmentId: row.enrollment_id, taskId: row.task_id, taskVersion: row.task_version,
    revision: row.revision, inputRevision: row.input_revision, status: row.status, remainingActions: row.action_budget - row.actions_used,
    events: actions.map((action) => ({ id: action.id, seq: action.session_revision, at: storedTime(action.created_at), action: action.action,
      receipt: { id: action.id, clientActionId: action.client_action_id, input: { activitySessionId: activityId, inputRevision: action.input_revision, responseDigest: action.response_digest },
        sessionRevision: action.session_revision, status: action.status, observation: action.public_observation } })) });
  const saved = activity.inputRevision === 0 ? null : (await tx.query("SELECT * FROM unfurl.activity_inputs WHERE activity_session_id=$1 AND input_revision=$2", [activityId, activity.inputRevision])).rows[0];
  const savedInput = saved ? await validateInputSnapshot({ activitySessionId: activityId, inputRevision: saved.input_revision, responseDigest: saved.response_digest, response: saved.response }) : null;
  return ActivityStateSchema.parse({ activity, savedInput });
}

export async function findActivity(tx: DbTransaction, enrollment: Enrollment, taskId: string, taskVersion: number): Promise<ActivityState | null> {
  const row = (await tx.query<{ id: string }>("SELECT id FROM unfurl.activity_sessions WHERE enrollment_id=$1 AND task_id=$2 AND task_version=$3", [enrollment.id, taskId, taskVersion])).rows[0];
  return row ? readActivity(tx, enrollment, row.id) : null;
}

export async function authoritativeActivity(tx: DbTransaction, enrollment: Enrollment, state: ActivityState): Promise<AuthoritativeActivity> {
  if (!state.savedInput) invariant();
  const inputs = (await tx.query(`SELECT DISTINCT i.* FROM unfurl.activity_inputs i JOIN unfurl.activity_actions a
    ON a.activity_session_id=i.activity_session_id AND a.input_revision=i.input_revision AND a.response_digest=i.response_digest
    WHERE i.activity_session_id=$1`, [state.activity.id])).rows;
  const receiptInputs = await Promise.all(inputs.map((row) => validateInputSnapshot({ activitySessionId: row.activity_session_id,
    inputRevision: row.input_revision, responseDigest: row.response_digest, response: row.response })));
  const assistance = await readAssistance(tx, enrollment, state.activity.taskId);
  const commitment = state.activity.events.find((event) => event.action.kind === "prediction.commit" && event.receipt.status === "completed");
  return { session: state.activity, input: InputSnapshotSchema.parse(state.savedInput), receipts: state.activity.events.map(({ receipt }) => receipt), receiptInputs,
    assistance: assistance.assistance, revealedFactIds: [...new Set(state.activity.events.flatMap((event) => event.receipt.observation?.kind === "dialogue" ? event.receipt.observation.revealedFacts.map(({ id }) => id) : []))],
    committedPredictionReceiptId: commitment?.receipt.id ?? null,
    predictionBeforeObservation: commitment !== undefined && !state.activity.events.some((event) => event.seq < commitment.seq && event.action.kind !== "prediction.commit") };
}
export async function readAssistance(tx: DbTransaction, enrollment: Enrollment, taskId: string) {
  const rows = (await tx.query<{ id: string; kind: "hint" | "worked_example" }>(`SELECT h.id,h.kind FROM unfurl.hint_usage h JOIN unfurl.enrollments e ON e.id=h.enrollment_id
    WHERE e.learner_id=$1 AND e.course_id=$2 AND h.task_id=$3 ORDER BY h.created_at,h.id`, [enrollment.learnerId, enrollment.courseId, taskId])).rows;
  return { assistance: rows.some(({ kind }) => kind === "worked_example") ? "worked_example" as const : rows.length ? "hinted" as const : "independent" as const,
    hintIdsUsed: rows.filter(({ kind }) => kind === "hint").map(({ id }) => id) };
}

export async function readEvaluation(tx: DbTransaction, enrollment: Enrollment, attemptId: string): Promise<EvaluationReceipt> {
  const row = (await tx.query(`SELECT v.*,a.activity_session_id,a.activity_input_revision,a.response_digest FROM unfurl.evaluations v JOIN unfurl.attempts a ON a.id=v.attempt_id
    WHERE a.id=$1 AND a.enrollment_id=$2 AND a.learner_id=$3`, [attemptId, enrollment.id, enrollment.learnerId])).rows[0];
  if (!row) notFound();
  const reviewRow = (await tx.query("SELECT * FROM unfurl.assessment_review_requests WHERE attempt_id=$1 ORDER BY expected_evaluation_revision DESC LIMIT 1", [attemptId])).rows[0];
    const review = reviewRow ? reviewFromRow(reviewRow) : null;
    return EvaluationReceiptSchema.parse({ revision: row.revision, review,
      submittedInput: { activitySessionId: row.activity_session_id, inputRevision: row.activity_input_revision, responseDigest: row.response_digest },
      evaluation: { id: row.id, attemptId: row.attempt_id, status: row.status, outcome: row.outcome, dimensions: row.dimensions, feedback: row.feedback, awardedXp: row.awarded_xp } });
}

export function reviewFromRow(reviewRow: QueryResultRow) {
  return AssessmentReviewRequestSchema.parse({ id: reviewRow.id, attemptId: reviewRow.attempt_id, evaluationId: reviewRow.evaluation_id,
    expectedEvaluationRevision: reviewRow.expected_evaluation_revision, reason: reviewRow.reason, comment: reviewRow.comment, status: reviewRow.status,
    resolution: reviewRow.resolution, resolvedEvaluationRevision: reviewRow.resolved_evaluation_revision, createdAt: storedTime(reviewRow.created_at),
      updatedAt: storedTime(reviewRow.updated_at), resolvedAt: reviewRow.resolved_at === null ? null : storedTime(reviewRow.resolved_at) });
}

export async function latestTaskAttempt(tx: DbTransaction, enrollment: Enrollment, activity: ActivitySessionPublic) {
  return (await tx.query<{ id: string; activity_input_revision: number }>(`SELECT id,activity_input_revision FROM unfurl.attempts
    WHERE enrollment_id=$1 AND task_id=$2 AND task_version=$3 AND activity_session_id=$4 ORDER BY submitted_at DESC,id DESC LIMIT 1`,
  [enrollment.id, activity.taskId, activity.taskVersion, activity.id])).rows[0] ?? null;
}

export async function readEvidence(tx: DbTransaction, enrollment: Enrollment): Promise<ConfirmableEvidence[]> {
  const rows = (await tx.query(`SELECT e.*, a.course_version_id,a.submitted_at, v.revision AS current_revision,v.status AS evaluation_status, ack.acknowledged_at
    FROM unfurl.learner_evidence e JOIN unfurl.attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
    JOIN unfurl.evaluations v ON v.id=e.evaluation_id AND v.attempt_id=a.id
    LEFT JOIN unfurl.feedback_acknowledgements ack ON ack.attempt_id=a.id AND ack.evaluation_revision=e.evaluation_revision
    WHERE e.enrollment_id=$1 AND a.learner_id=$2`, [enrollment.id, enrollment.learnerId])).rows;
  return rows.map((row) => ({ id: row.id, enrollmentId: row.enrollment_id, courseVersionId: row.course_version_id,
    outcomeId: row.outcome_id, attemptId: row.attempt_id, evaluationId: row.evaluation_id, evaluationRevision: row.evaluation_revision,
    currentEvaluationRevision: row.current_revision, evaluationStatus: row.evaluation_status, taskId: row.task_id, taskVersion: row.task_version,
    evidenceGroupId: row.evidence_group_id, assistance: row.assistance, reviewState: row.review_state,
    dimensionStatuses: z.record(z.string(), z.enum(["met", "partial", "not_met", "uncertain"])).parse(row.context.dimensionStatuses),
    submittedAt: storedTime(row.submitted_at), feedbackAcknowledgedAt: row.acknowledged_at === null ? null : storedTime(row.acknowledged_at) }));
}

export async function readSupport(tx: DbTransaction, enrollment: Enrollment): Promise<SupportOffer | null> {
  const row = (await tx.query("SELECT * FROM unfurl.support_offers WHERE enrollment_id=$1 AND status IN ('offered','accepted')", [enrollment.id])).rows[0];
  if (!row) return null;
  return supportFromRow(tx, row);
}

export async function requireSupport(tx: DbTransaction, enrollment: Enrollment, offerId: string): Promise<SupportOffer> {
  const row = (await tx.query("SELECT * FROM unfurl.support_offers WHERE enrollment_id=$1 AND id=$2", [enrollment.id, offerId])).rows[0];
  if (!row) notFound();
  return supportFromRow(tx, row);
}

async function supportFromRow(tx: DbTransaction, row: QueryResultRow): Promise<SupportOffer> {
  const tasks = (await tx.query("SELECT * FROM unfurl.support_offer_tasks WHERE offer_id=$1 ORDER BY slot", [row.id])).rows;
  return SupportOfferSchema.parse({ id: row.id, enrollmentId: row.enrollment_id, courseVersionId: row.course_version_id, policyVersion: row.policy_version,
    basedOnRouteRevision: row.based_on_route_revision, target: { outcomeId: row.target_outcome_id, dimensionIds: row.target_dimension_ids },
    triggerKind: row.trigger_kind, reasonCode: row.reason_code, basisEvidenceIds: row.basis_evidence_ids, explanation: row.explanation,
    tasks: tasks.map((task) => ({ lessonId: task.lesson_id, taskId: task.task_id, taskVersion: task.task_version })),
    explanationBlock: row.explanation_lesson_id === null ? null : { lessonId: row.explanation_lesson_id, blockId: row.explanation_block_id },
    estimatedStudyMinutes: row.estimated_study_minutes, returnPoint: { lessonId: row.return_lesson_id, taskId: row.return_task_id },
    completionCheck: row.completion_task_id === null ? null : { taskId: row.completion_task_id, dimensionIds: row.completion_dimension_ids },
    status: row.status, createdAt: storedTime(row.created_at), updatedAt: storedTime(row.updated_at) });
}
