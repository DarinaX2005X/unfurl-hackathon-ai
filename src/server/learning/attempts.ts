import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { SubmitActivityAttemptSchema, sameInputIdentity, type SubmitActivityAttempt } from "@/domain/activity";
import { AttemptReceiptSchema } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { ServiceFault } from "@/server/auth/errors";
import { executeIdempotentInTransaction, requestDigest } from "@/server/idempotency";
import { lockLearnerCourseStableTaskTx } from "@/server/progression";
import { getServerMechanic } from "@/server/mechanics/registry";
import { GradeDecisionSchema, type GradeDecision } from "@/server/evaluation/contracts";
import { enqueueLearningJobTx } from "@/server/runs/enqueue";
import type { LearningTransactions, LearningCommand } from "./service";
import { invalidLearningFields } from "./actions";
import { validateSubmittedActivity } from "./submission";
import { commitSemanticEvaluationTx } from "./evaluation";
import { projectLearningSession } from "./projection";
import * as repository from "./repository";
import { activateLearningJob, type LearningAdmission } from "./queue";

const attemptReference = z.object({ attemptId: IdSchema }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidLearningFields(parsed.error.issues);
  return parsed.data;
}
export function createAttemptOperations(transactions: LearningTransactions, createId: () => string, admission?: LearningAdmission) {
  return {
    async submitAttempt(actor: Actor, enrollmentId: string, command: LearningCommand<SubmitActivityAttempt>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, command.key);
      const body = parse(SubmitActivityAttemptSchema, command.body);
      const accepted = await transactions.run(async (tx) => {
        const identity = await repository.requireEnrollment(tx, actor, enrollmentId);
        await lockLearnerCourseStableTaskTx(tx, { learnerId: actor.id, courseId: identity.courseId, taskId: body.taskId });
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const digest = requestDigest({ enrollmentId, ...body });
        const receipt = await executeIdempotentInTransaction(tx, actor, { operation: "learning.attempt.submit", key: command.key,
          body: { enrollmentId, ...body }, parseResult: attemptReference }, async () => {
          const existing = (await tx.query<{ id: string; request_digest: string }>("SELECT id,request_digest FROM unfurl.attempts WHERE learner_id=$1 AND client_attempt_id=$2", [actor.id, body.clientAttemptId])).rows[0];
          if (existing) {
            if (existing.request_digest !== digest) throw new ServiceFault(409, "idempotency_conflict", "request.idempotencyConflict");
            return { status: 200, data: { attemptId: existing.id } };
          }
          const task = await repository.requireCurrentTask(tx, enrollment, body.taskId, body.taskVersion);
          const state = await repository.readActivity(tx, enrollment, body.activitySessionId, true);
          if (state.activity.taskId !== task.id || state.activity.taskVersion !== task.taskVersion || !state.savedInput || !sameInputIdentity(state.savedInput, body)) {
            repository.revisionConflict(state.activity.revision, "learning.inputChanged");
          }
          const activity = await repository.authoritativeActivity(tx, enrollment, state);
          const response = await validateSubmittedActivity(task, body.response, activity);
          const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
          const mechanic = getServerMechanic(task.mechanicId, task.mechanicVersion) ?? repository.invariant();
          const privateData = mechanic.parsePrivate(privateTask.evaluatorData);
          // No provider is injected here. Grading that needs external work is admitted by the durable handler slice.
          let decision: GradeDecision;
          try { decision = GradeDecisionSchema.parse(await mechanic.evaluate({ task, response, privateData, activity }, { model: null, signal: AbortSignal.timeout(5_000) })); }
          catch { decision = { status: "unavailable", outcome: null, dimensions: [],
            feedback: { explanation: "Assessment could not finish. Your saved response is retained for retry.", nextAction: "wait" } }; }
          const frozen = JSON.stringify(activity);
          const snapshotBytes = (await tx.query<{ size: number }>("SELECT octet_length($1::jsonb::text) AS size", [frozen])).rows[0]?.size;
          if (snapshotBytes === undefined || snapshotBytes > 2 * 1024 * 1024) throw new ServiceFault(503, "service_unavailable", "learning.activitySnapshotTooLarge", false);
          const attemptId = createId(), evaluationId = createId();
          const assistance = await repository.readAssistance(tx, enrollment, task.id);
          await tx.query(`INSERT INTO unfurl.attempts(id,learner_id,enrollment_id,course_version_id,task_id,task_version,client_attempt_id,idempotency_key,response,assistance,hint_ids_used,
            activity_session_id,activity_input_revision,response_digest,request_digest,activity_snapshot,submitted_activity_revision,submitted_route_revision)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
          [attemptId, actor.id, enrollment.id, enrollment.courseVersionId, task.id, task.taskVersion, body.clientAttemptId, command.key,
            JSON.stringify(response), activity.assistance, assistance.hintIdsUsed, state.activity.id, state.savedInput.inputRevision,
            state.savedInput.responseDigest, digest, frozen, state.activity.revision, enrollment.routeRevision]);
          await tx.query(`INSERT INTO unfurl.evaluations(id,attempt_id,status,outcome,dimensions,feedback,awarded_xp,revision)
            VALUES($1,$2,'pending',NULL,'[]',$3::jsonb,0,1)`, [evaluationId, attemptId, JSON.stringify({ explanation: "Your response is saved for assessment.", nextAction: "wait" })]);
          if (decision.status === "unavailable") {
            await tx.query("UPDATE unfurl.evaluations SET status='unavailable',dimensions=$2::jsonb,feedback=$3::jsonb,updated_at=now() WHERE id=$1", [evaluationId, JSON.stringify(decision.dimensions), JSON.stringify(decision.feedback)]);
            await enqueueLearningJobTx(tx, { kind: "evaluation", evaluationId, targetEvaluationRevision: 1 }, { dispatch: false });
          } else {
            await commitSemanticEvaluationTx(tx, { enrollment, task, privateTask, activity, attemptId, evaluationId, revision: 1, decision }, createId);
          }
          return { status: 201, data: { attemptId } };
        });
        const current = await repository.requireEnrollment(tx, actor, enrollmentId);
        const evaluation = await repository.readEvaluation(tx, current, receipt.data.attemptId);
        const session = await projectLearningSession(tx, current);
        return { status: receipt.status, data: AttemptReceiptSchema.parse({ attemptId: receipt.data.attemptId, evaluation,
          route: session.route, progress: session.progress, support: session.support }) };
      });
      if (accepted.data.evaluation.evaluation.status !== "unavailable" || !await activateLearningJob(transactions, admission, actor,
        { kind: "evaluation", evaluationId: accepted.data.evaluation.evaluation.id, targetEvaluationRevision: accepted.data.evaluation.revision }, null)) return accepted;
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
        const session = await projectLearningSession(tx, enrollment);
        return { status: 202 as const, data: AttemptReceiptSchema.parse({ attemptId: accepted.data.attemptId,
          evaluation: await repository.readEvaluation(tx, enrollment, accepted.data.attemptId), route: session.route, progress: session.progress, support: session.support }) };
      });
    },
  };
}
