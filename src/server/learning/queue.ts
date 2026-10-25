import "server-only";
import type { Actor } from "@/server/auth/actor";
import type { TaskPublic } from "@/domain/mechanics";
import type { LearningTransactions } from "./service";
import { lockLearnerCourseStableTaskTx } from "@/server/progression";
import { resumeLearningJobTx, type LearningJobTarget } from "@/server/runs/enqueue";
import * as repository from "./repository";
import { getServerMechanic } from "@/server/mechanics/registry";

/** Runtime composition checks actual handler, provider/executor and shared-budget readiness. */
export interface LearningAdmission { assertAvailable(input: { kind: "evaluation" | "activity_action"; task: TaskPublic }): Promise<void> }

export function learningCapabilityRequirements(input: { kind: "evaluation" | "activity_action"; task: TaskPublic }) {
  const handle = getServerMechanic(input.task.mechanicId, input.task.mechanicVersion) ?? repository.invariant();
  handle.parseTask(input.task);
  const python = handle.descriptor.requirements.includes("sandbox");
  const dialogue = input.kind === "activity_action" && handle.descriptor.actions.includes("dialogue.turn");
  const rubric = input.kind === "evaluation" && handle.descriptor.requirements.includes("model");
  return { model: dialogue || rubric, python, dialogue, rubric };
}

/** External admission happens after durable acceptance and outside every transaction. */
export async function activateLearningJob(transactions: LearningTransactions, admission: LearningAdmission | undefined, actor: Actor,
  target: LearningJobTarget, explicit: { retryReceiptId: string; expectedRetryEpoch: number } | null): Promise<boolean> {
  if (!admission) return false;
  const identity = await transactions.run(async (tx) => {
    const row = target.kind === "evaluation" ? (await tx.query(`SELECT a.enrollment_id,a.task_id,a.task_version,a.learner_id FROM unfurl.evaluations v JOIN unfurl.attempts a ON a.id=v.attempt_id WHERE v.id=$1 AND a.learner_id=$2`, [target.evaluationId, actor.id])).rows[0]
      : (await tx.query(`SELECT s.enrollment_id,s.task_id,s.task_version,e.learner_id FROM unfurl.activity_actions a JOIN unfurl.activity_sessions s ON s.id=a.activity_session_id JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE a.id=$1 AND e.learner_id=$2`, [target.activityActionId, actor.id])).rows[0];
    if (!row) repository.notFound();
    const enrollment = await repository.requireEnrollment(tx, actor, row.enrollment_id);
    const program = await repository.loadProgram(tx, enrollment);
    const task = program.tasks.find(({ task }) => task.id === row.task_id && task.taskVersion === row.task_version)?.task ?? repository.invariant();
    return { enrollment, task };
  });
  try { await admission.assertAvailable({ kind: target.kind, task: identity.task }); }
  catch { return false; }
  return transactions.run(async (tx) => {
    await lockLearnerCourseStableTaskTx(tx, { learnerId: actor.id, courseId: identity.enrollment.courseId, taskId: identity.task.id });
    const enrollment = await repository.requireEnrollment(tx, actor, identity.enrollment.id, true);
    if (enrollment.status === "archived") return false;
    const job = target.kind === "evaluation" ? (await tx.query(`SELECT j.id,j.status,j.retry_epoch,EXISTS(SELECT 1 FROM unfurl.run_steps s WHERE s.job_id=j.id) AS has_steps
      FROM unfurl.execution_jobs j WHERE j.evaluation_id=$1 AND j.target_evaluation_revision=$2`, [target.evaluationId, target.targetEvaluationRevision])).rows[0]
      : (await tx.query(`SELECT j.id,j.status,j.retry_epoch,EXISTS(SELECT 1 FROM unfurl.run_steps s WHERE s.job_id=j.id) AS has_steps
        FROM unfurl.execution_jobs j WHERE j.activity_action_id=$1`, [target.activityActionId])).rows[0];
    if (!job || !["waiting", "failed"].includes(job.status)) return false;
    if (explicit && explicit.expectedRetryEpoch !== job.retry_epoch) return false;
    if (!explicit && (job.retry_epoch !== 0 || job.has_steps)) return false;
    await resumeLearningJobTx(tx, target, { actorId: actor.id, expectedRetryEpoch: job.retry_epoch,
      explicitPaidRetry: explicit !== null && Boolean(job.has_steps), ...(explicit && job.has_steps ? { retryReceiptId: explicit.retryReceiptId } : {}) });
    if (target.kind === "evaluation") {
      if (target.targetEvaluationRevision === 1) await tx.query("UPDATE unfurl.evaluations SET status='pending',updated_at=now() WHERE id=$1 AND revision=1 AND status='unavailable'", [target.evaluationId]);
      else await tx.query("UPDATE unfurl.assessment_review_requests SET status='queued',updated_at=now() WHERE evaluation_id=$1 AND expected_evaluation_revision=$2 AND status='unavailable'", [target.evaluationId, target.targetEvaluationRevision - 1]);
    } else {
      const action = (await tx.query<{ activity_session_id: string }>("UPDATE unfurl.activity_actions SET status='pending',completed_session_revision=NULL WHERE id=$1 AND status='unavailable' RETURNING activity_session_id", [target.activityActionId])).rows[0];
      if (action) await tx.query("UPDATE unfurl.activity_sessions SET revision=revision+1,updated_at=now() WHERE id=$1", [action.activity_session_id]);
    }
    return true;
  });
}
