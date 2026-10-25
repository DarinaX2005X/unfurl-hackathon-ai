import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { FeedbackAcknowledgementSchema } from "@/domain/learning";
import { AssistanceReceiptSchema, RevealReceiptSchema, HintInputSchema, StartActivityInputSchema, EvaluationRevisionInputSchema } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { ServiceFault } from "@/server/auth/errors";
import type { DbTransaction } from "@/server/db";
import { executeIdempotentInTransaction } from "@/server/idempotency";
import { lockLearnerCourseStableTaskTx } from "@/server/progression";
import { invalidLearningFields } from "./actions";
import type { LearningTransactions, LearningCommand } from "./service";
import * as repository from "./repository";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidLearningFields(parsed.error.issues);
  return parsed.data;
}
const hintReference = z.object({ usageId: IdSchema }).strict();
const feedbackReference = z.object({ attemptId: IdSchema, evaluationRevision: z.number().int().positive() }).strict();

export function createAssistanceOperations(transactions: LearningTransactions, createId: () => string) {
  async function lockTask(tx: DbTransaction, actor: Actor, enrollmentId: string, taskId: string) {
    const identity = await repository.requireEnrollment(tx, actor, enrollmentId);
    await lockLearnerCourseStableTaskTx(tx, { learnerId: actor.id, courseId: identity.courseId, taskId });
    return repository.requireEnrollment(tx, actor, enrollmentId, true);
  }
  return {
    requestHint(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof HintInputSchema>>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, command.key);
      const body = parse(HintInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await lockTask(tx, actor, enrollmentId, body.taskId);
        const receipt = await executeIdempotentInTransaction(tx, actor, { operation: "learning.hint", key: command.key,
          body: { enrollmentId, ...body }, parseResult: hintReference }, async () => {
          const task = await repository.requireCurrentTask(tx, enrollment, body.taskId, body.taskVersion);
          const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
          if (privateTask.hints.length !== task.availableHints) repository.invariant();
          if (privateTask.hints[body.hintIndex] === undefined) throw invalidLearningFields([{ path: ["hintIndex"], message: "This task does not have that hint." }]);
          await tx.query(`INSERT INTO unfurl.hint_usage(id,enrollment_id,task_id,task_version,kind,hint_index)
            VALUES($1,$2,$3,$4,'hint',$5) ON CONFLICT(enrollment_id,task_id,task_version,kind,hint_index)
            DO NOTHING`, [createId(), enrollmentId, task.id, task.taskVersion, body.hintIndex]);
          const row = (await tx.query<{ id: string }>("SELECT id FROM unfurl.hint_usage WHERE enrollment_id=$1 AND task_id=$2 AND task_version=$3 AND kind='hint' AND hint_index=$4", [enrollmentId, task.id, task.taskVersion, body.hintIndex])).rows[0];
          if (!row) repository.invariant();
          return { status: 200, data: { usageId: row.id } };
        });
        const privateTask = await repository.loadPrivateTask(tx, enrollment, body.taskId, body.taskVersion);
        const assistance = await repository.readAssistance(tx, enrollment, body.taskId);
        if (assistance.assistance === "independent") repository.invariant();
        return { status: 200 as const, data: AssistanceReceiptSchema.parse({ hintId: receipt.data.usageId, content: privateTask.hints[body.hintIndex], assistance: assistance.assistance }) };
      });
    },
    revealAnswer(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof StartActivityInputSchema>>) {
      parse(IdSchema, enrollmentId); parse(IdSchema, command.key);
      const body = parse(StartActivityInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollment = await lockTask(tx, actor, enrollmentId, body.taskId);
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.reveal", key: command.key,
          body: { enrollmentId, ...body }, parseResult: hintReference }, async () => {
          const task = await repository.requireCurrentTask(tx, enrollment, body.taskId, body.taskVersion);
          const privateTask = await repository.loadPrivateTask(tx, enrollment, task.id, task.taskVersion);
          if (privateTask.workedExample === null) throw new ServiceFault(503, "service_unavailable", "learning.workedExampleUnavailable", false);
          await tx.query(`INSERT INTO unfurl.hint_usage(id,enrollment_id,task_id,task_version,kind,hint_index)
            VALUES($1,$2,$3,$4,'worked_example',NULL) ON CONFLICT(enrollment_id,task_id,task_version,kind,hint_index) DO NOTHING`, [createId(), enrollmentId, task.id, task.taskVersion]);
          const row = (await tx.query<{ id: string }>("SELECT id FROM unfurl.hint_usage WHERE enrollment_id=$1 AND task_id=$2 AND task_version=$3 AND kind='worked_example'", [enrollmentId, task.id, task.taskVersion])).rows[0];
          if (!row) repository.invariant();
          return { status: 200, data: { usageId: row.id } };
        });
        const privateTask = await repository.loadPrivateTask(tx, enrollment, body.taskId, body.taskVersion);
        return { status: 200 as const, data: RevealReceiptSchema.parse({ content: privateTask.workedExample, assistance: "worked_example" }) };
      });
    },
    getEvaluation(actor: Actor, attemptId: string) {
      parse(IdSchema, attemptId);
      return transactions.run(async (tx) => {
        const enrollmentId = await repository.attemptEnrollmentId(tx, actor, attemptId);
        return repository.readEvaluation(tx, await repository.requireEnrollment(tx, actor, enrollmentId), attemptId);
      });
    },
    acknowledgeFeedback(actor: Actor, attemptId: string, command: LearningCommand<z.infer<typeof EvaluationRevisionInputSchema>>) {
      parse(IdSchema, attemptId); parse(IdSchema, command.key);
      const body = parse(EvaluationRevisionInputSchema, command.body);
      return transactions.run(async (tx) => {
        const enrollmentId = await repository.attemptEnrollmentId(tx, actor, attemptId);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
        const receipt = await executeIdempotentInTransaction(tx, actor, { operation: "learning.feedback.ack", key: command.key,
          body: { attemptId, ...body }, parseResult: feedbackReference }, async () => {
          const evaluation = await repository.readEvaluation(tx, enrollment, attemptId);
          if (evaluation.revision !== body.expectedEvaluationRevision) repository.revisionConflict(evaluation.revision, "learning.evaluationChanged");
          if (!["evaluated", "uncertain"].includes(evaluation.evaluation.status)) throw new ServiceFault(409, "revision_conflict", "learning.feedbackUnavailable", false);
          await tx.query("INSERT INTO unfurl.feedback_acknowledgements(attempt_id,evaluation_revision) VALUES($1,$2) ON CONFLICT(attempt_id,evaluation_revision) DO NOTHING", [attemptId, evaluation.revision]);
          return { status: 200, data: { attemptId, evaluationRevision: evaluation.revision } };
        });
        const row = (await tx.query("SELECT acknowledged_at FROM unfurl.feedback_acknowledgements WHERE attempt_id=$1 AND evaluation_revision=$2", [receipt.data.attemptId, receipt.data.evaluationRevision])).rows[0];
        if (!row) repository.invariant();
        return { status: 200 as const, data: FeedbackAcknowledgementSchema.parse({ ...receipt.data, acknowledgedAt: repository.storedTime(row.acknowledged_at) }) };
      });
    },
  };
}
