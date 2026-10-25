import "server-only";
import { z } from "zod";
import { ActivityActionSchema, ActivitySessionPublicSchema, ActionReceiptSchema, InputSnapshotSchema, activityActionCost, canonicalResponseJson, validateInputSnapshot } from "@/domain/activity";
import type { DbTransaction } from "@/server/db";
import type { ExecutionTarget } from "@/server/runs/ports";
import { lockLearnerCourseStableTaskTx } from "@/server/progression";
import type { AuthoritativeActivity } from "@/server/evaluation/contracts";
import * as repository from "./repository";

const FrozenActivitySchema = z.object({ session: ActivitySessionPublicSchema, input: InputSnapshotSchema,
  receipts: z.array(ActionReceiptSchema).max(100), receiptInputs: z.array(InputSnapshotSchema).max(100),
  assistance: z.enum(["independent", "hinted", "worked_example"]), revealedFactIds: z.array(z.string()).max(1_200),
  committedPredictionReceiptId: z.uuid().nullable(), predictionBeforeObservation: z.boolean() }).strict();

/** Business locks precede the runner job lock. This function never performs external work. */
export async function assertLearningJobAuthority(tx: DbTransaction, target: ExecutionTarget): Promise<void> {
  if (target.kind !== "evaluation" && target.kind !== "activity_action") repository.notFound();
  const identity = target.kind === "evaluation" ? (await tx.query(`SELECT a.enrollment_id,a.task_id,a.activity_session_id,e.learner_id,e.course_id FROM unfurl.evaluations v
    JOIN unfurl.attempts a ON a.id=v.attempt_id JOIN unfurl.enrollments e ON e.id=a.enrollment_id AND e.learner_id=a.learner_id AND e.course_version_id=a.course_version_id WHERE v.id=$1`, [target.evaluationId])).rows[0]
    : (await tx.query(`SELECT s.enrollment_id,s.task_id,s.id AS activity_session_id,e.learner_id,e.course_id FROM unfurl.activity_actions a
      JOIN unfurl.activity_sessions s ON s.id=a.activity_session_id JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE a.id=$1`, [target.activityActionId])).rows[0];
  if (!identity) repository.notFound();
  await lockLearnerCourseStableTaskTx(tx, { learnerId: identity.learner_id, courseId: identity.course_id, taskId: identity.task_id });
  const enrollment = (await tx.query("SELECT id FROM unfurl.enrollments WHERE id=$1 AND learner_id=$2 FOR UPDATE", [identity.enrollment_id, identity.learner_id])).rows[0];
  if (!enrollment) repository.notFound();
  await tx.query("SELECT id FROM unfurl.activity_sessions WHERE id=$1 AND enrollment_id=$2 FOR UPDATE", [identity.activity_session_id, identity.enrollment_id]);
  if (target.kind === "evaluation") {
    const evaluation = (await tx.query<{ revision: number; status: string }>("SELECT revision,status FROM unfurl.evaluations WHERE id=$1 FOR UPDATE", [target.evaluationId])).rows[0] ?? repository.notFound();
    if (evaluation.revision === target.targetEvaluationRevision) return;
    if (evaluation.revision + 1 !== target.targetEvaluationRevision || !["evaluated", "uncertain"].includes(evaluation.status)) repository.revisionConflict(evaluation.revision, "learning.evaluationChanged");
    const review = (await tx.query("SELECT id FROM unfurl.assessment_review_requests WHERE evaluation_id=$1 AND expected_evaluation_revision=$2 AND status IN ('queued','running','unavailable') FOR UPDATE", [target.evaluationId, evaluation.revision])).rows[0];
    if (!review) repository.revisionConflict(evaluation.revision, "learning.evaluationChanged");
  } else {
    if (!(await tx.query("SELECT id FROM unfurl.activity_actions WHERE id=$1 FOR UPDATE", [target.activityActionId])).rows[0]) repository.notFound();
  }
}

async function enrollmentForStoredTarget(tx: DbTransaction, enrollmentId: string) {
  const row = (await tx.query("SELECT * FROM unfurl.enrollments WHERE id=$1", [enrollmentId])).rows[0] ?? repository.notFound();
  return repository.enrollmentFromRow(row);
}

export async function loadEvaluationWork(tx: DbTransaction, target: Extract<ExecutionTarget, { kind: "evaluation" }>) {
  const row = (await tx.query(`SELECT a.*,v.id AS evaluation_id,v.revision AS evaluation_revision,v.status AS evaluation_status,v.outcome AS evaluation_outcome,
    v.dimensions AS evaluation_dimensions FROM unfurl.evaluations v JOIN unfurl.attempts a ON a.id=v.attempt_id WHERE v.id=$1`, [target.evaluationId])).rows[0] ?? repository.notFound();
  const enrollment = await enrollmentForStoredTarget(tx, row.enrollment_id);
  if (enrollment.learnerId !== row.learner_id || enrollment.courseVersionId !== row.course_version_id) repository.invariant();
  const program = await repository.loadProgram(tx, enrollment);
  const task = program.tasks.find(({ task }) => task.id === row.task_id && task.taskVersion === row.task_version)?.task ?? repository.invariant();
  const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
  const activity = FrozenActivitySchema.parse(row.activity_snapshot);
  await validateInputSnapshot(activity.input);
  await Promise.all(activity.receiptInputs.map(validateInputSnapshot));
  if (activity.session.enrollmentId !== enrollment.id || activity.session.id !== row.activity_session_id || activity.session.taskId !== task.id || activity.session.taskVersion !== task.taskVersion ||
    activity.input.inputRevision !== row.activity_input_revision || activity.input.responseDigest !== row.response_digest || activity.assistance !== row.assistance ||
    canonicalResponseJson(activity.input.response) !== canonicalResponseJson(row.response) || activity.session.revision !== row.submitted_activity_revision) repository.invariant();
  const review = target.targetEvaluationRevision > 1 ? (await tx.query("SELECT * FROM unfurl.assessment_review_requests WHERE evaluation_id=$1 AND expected_evaluation_revision=$2", [target.evaluationId, target.targetEvaluationRevision - 1])).rows[0] : undefined;
  return { enrollment, task, privateTask, activity: activity as AuthoritativeActivity, attemptId: row.id as string, evaluationId: target.evaluationId,
    revision: target.targetEvaluationRevision, currentRevision: row.evaluation_revision as number, currentStatus: row.evaluation_status as string,
    currentOutcome: row.evaluation_outcome as string | null, currentDimensions: row.evaluation_dimensions as unknown, review: review ? repository.reviewFromRow(review) : null };
}

export async function loadActionWork(tx: DbTransaction, target: Extract<ExecutionTarget, { kind: "activity_action" }>) {
  const row = (await tx.query(`SELECT a.*,s.enrollment_id,s.task_id,s.task_version,s.action_budget FROM unfurl.activity_actions a
    JOIN unfurl.activity_sessions s ON s.id=a.activity_session_id WHERE a.id=$1`, [target.activityActionId])).rows[0] ?? repository.notFound();
  const enrollment = await enrollmentForStoredTarget(tx, row.enrollment_id);
  const program = await repository.loadProgram(tx, enrollment);
  const task = program.tasks.find(({ task }) => task.id === row.task_id && task.taskVersion === row.task_version)?.task ?? repository.invariant();
  const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
  const state = await repository.readActivity(tx, enrollment, row.activity_session_id);
  const snapshotRow = (await tx.query("SELECT * FROM unfurl.activity_inputs WHERE activity_session_id=$1 AND input_revision=$2 AND response_digest=$3", [row.activity_session_id, row.input_revision, row.response_digest])).rows[0] ?? repository.invariant();
  const snapshot = await validateInputSnapshot({ activitySessionId: row.activity_session_id, inputRevision: row.input_revision, responseDigest: row.response_digest, response: snapshotRow.response });
  const priorTerminals = (await tx.query<{ id: string; completed_session_revision: number | null }>("SELECT id,completed_session_revision FROM unfurl.activity_actions WHERE activity_session_id=$1 AND session_revision<$2", [state.activity.id, row.session_revision])).rows;
  const visible = new Set(priorTerminals.filter((entry) => entry.completed_session_revision !== null && entry.completed_session_revision < row.session_revision).map(({ id }) => id));
  const events = state.activity.events.filter((event) => event.seq < row.session_revision).map((event) => visible.has(event.receipt.id) ? event :
    { ...event, receipt: { ...event.receipt, status: "pending" as const, observation: null } });
  const remaining = row.action_budget - events.reduce((sum, event) => sum + activityActionCost(event.action), 0);
  const activity = await repository.authoritativeActivity(tx, enrollment, { savedInput: snapshot, activity: { ...state.activity,
    revision: row.session_revision - 1, inputRevision: row.input_revision, events, remainingActions: remaining, status: remaining ? "active" : "budget_exhausted" } });
  return { enrollment, task, privateTask, activity, actionId: row.id as string, clientActionId: row.client_action_id as string,
    action: ActivityActionSchema.parse(row.action), status: row.status as string, sessionId: state.activity.id, currentSessionRevision: state.activity.revision };
}
