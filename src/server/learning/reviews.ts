import "server-only";
import { z } from "zod";
import { IdSchema, RevisionSchema } from "@/domain/common";
import { AssessmentReviewInputSchema, EvaluationRevisionInputSchema, ReviewReceiptSchema } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { lockLearnerCourseStableTaskTx } from "@/server/progression";
import { executeIdempotentInTransaction } from "@/server/idempotency";
import { enqueueLearningJobTx } from "@/server/runs/enqueue";
import type { DbTransaction } from "@/server/db";
import type { LearningCommand, LearningTransactions } from "./service";
import { activateLearningJob, type LearningAdmission } from "./queue";
import { invalidLearningFields } from "./actions";
import { refreshCoverageTx } from "./evaluation";
import * as repository from "./repository";

const reviewReference = z.object({ reviewId: IdSchema }).strict();
const retryReference = z.object({ evaluationId: IdSchema, targetRevision: RevisionSchema, retryEpoch: z.number().int().nonnegative().nullable(), hadEffects: z.boolean() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalidLearningFields(parsed.error.issues); return parsed.data;
}
async function lockAttempt(tx: DbTransaction, actor: Actor, attemptId: string) {
  const enrollmentId = await repository.attemptEnrollmentId(tx, actor, attemptId);
  const identity = await repository.requireEnrollment(tx, actor, enrollmentId);
  const attempt = (await tx.query<{ task_id: string }>("SELECT task_id FROM unfurl.attempts WHERE id=$1 AND enrollment_id=$2", [attemptId, enrollmentId])).rows[0] ?? repository.notFound();
  await lockLearnerCourseStableTaskTx(tx, { learnerId: actor.id, courseId: identity.courseId, taskId: attempt.task_id });
  const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId, true);
  if (enrollment.status === "archived") repository.revisionConflict(enrollment.routeRevision, "learning.enrollmentInactive");
  await tx.query("SELECT id FROM unfurl.evaluations WHERE attempt_id=$1 FOR UPDATE", [attemptId]);
  return enrollment;
}
async function readReview(tx: DbTransaction, actor: Actor, attemptId: string, reviewId: string) {
  const enrollmentId = await repository.attemptEnrollmentId(tx, actor, attemptId);
  const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
  const row = (await tx.query("SELECT * FROM unfurl.assessment_review_requests WHERE id=$1 AND attempt_id=$2", [reviewId, attemptId])).rows[0] ?? repository.notFound();
  const review = repository.reviewFromRow(row);
  const evaluation = await repository.readEvaluation(tx, enrollment, attemptId);
  return ReviewReceiptSchema.parse({ review, evaluation: { ...evaluation, review } });
}
async function retryIdentity(tx: DbTransaction, evaluationId: string, target: number) {
  const row = (await tx.query<{ retry_epoch: number; has_steps: boolean }>("SELECT retry_epoch,EXISTS(SELECT 1 FROM unfurl.run_steps s WHERE s.job_id=j.id) AS has_steps FROM unfurl.execution_jobs j WHERE evaluation_id=$1 AND target_evaluation_revision=$2", [evaluationId, target])).rows[0] ?? repository.invariant();
  return { retryEpoch: row.retry_epoch, hadEffects: row.has_steps };
}

export function createReviewOperations(transactions: LearningTransactions, createId: () => string, admission?: LearningAdmission) {
  return {
    async requestReview(actor: Actor, attemptId: string, command: LearningCommand<z.infer<typeof AssessmentReviewInputSchema>>) {
      parse(IdSchema, attemptId); parse(IdSchema, command.key); const body = parse(AssessmentReviewInputSchema, command.body);
      const accepted = await transactions.run(async (tx) => {
        const enrollment = await lockAttempt(tx, actor, attemptId);
        return executeIdempotentInTransaction(tx, actor, { operation: "learning.review.request", key: command.key, body: { attemptId, ...body }, parseResult: reviewReference }, async () => {
          const receipt = await repository.readEvaluation(tx, enrollment, attemptId);
          if (receipt.revision !== body.expectedEvaluationRevision || !["evaluated", "uncertain"].includes(receipt.evaluation.status)) repository.revisionConflict(receipt.revision, "learning.evaluationChanged");
          const existing = (await tx.query<{ id: string }>("SELECT id FROM unfurl.assessment_review_requests WHERE attempt_id=$1 AND expected_evaluation_revision=$2", [attemptId, receipt.revision])).rows[0];
          if (existing) return { status: 202, data: { reviewId: existing.id } };
          const reviewId = createId();
          await tx.query(`INSERT INTO unfurl.assessment_review_requests(id,attempt_id,evaluation_id,expected_evaluation_revision,reason,comment,status)
            VALUES($1,$2,$3,$4,$5,$6,'unavailable')`, [reviewId, attemptId, receipt.evaluation.id, receipt.revision, body.reason, body.comment]);
          await tx.query("UPDATE unfurl.learner_evidence SET review_state='contested' WHERE evaluation_id=$1 AND evaluation_revision=$2 AND review_state='confirmed'", [receipt.evaluation.id, receipt.revision]);
          await enqueueLearningJobTx(tx, { kind: "evaluation", evaluationId: receipt.evaluation.id, targetEvaluationRevision: receipt.revision + 1 }, { dispatch: false });
          await refreshCoverageTx(tx, enrollment);
          await tx.query(`UPDATE unfurl.support_offers SET status='superseded',updated_at=now() WHERE enrollment_id=$1 AND status='offered' AND target_outcome_id IN
            (SELECT outcome_id FROM unfurl.learner_evidence WHERE evaluation_id=$2 AND evaluation_revision=$3)`, [enrollment.id, receipt.evaluation.id, receipt.revision]);
          return { status: 202, data: { reviewId } };
        });
      });
      const current = await transactions.run((tx) => readReview(tx, actor, attemptId, accepted.data.reviewId));
      if (current.review.status === "unavailable") await activateLearningJob(transactions, admission, actor, { kind: "evaluation", evaluationId: current.review.evaluationId, targetEvaluationRevision: current.review.expectedEvaluationRevision + 1 }, null);
      return { status: 202 as const, data: await transactions.run((tx) => readReview(tx, actor, attemptId, accepted.data.reviewId)) };
    },
    async retryEvaluation(actor: Actor, attemptId: string, command: LearningCommand<z.infer<typeof EvaluationRevisionInputSchema>>) {
      parse(IdSchema, attemptId); parse(IdSchema, command.key); const body = parse(EvaluationRevisionInputSchema, command.body);
      const reference = await transactions.run(async (tx) => {
        const enrollment = await lockAttempt(tx, actor, attemptId);
        return executeIdempotentInTransaction(tx, actor, { operation: "learning.evaluation.retry", key: command.key, body: { attemptId, ...body }, parseResult: retryReference }, async () => {
          const receipt = await repository.readEvaluation(tx, enrollment, attemptId);
          if (receipt.revision !== body.expectedEvaluationRevision) repository.revisionConflict(receipt.revision, "learning.evaluationChanged");
          if (["evaluated", "uncertain"].includes(receipt.evaluation.status)) return { status: 200, data: { evaluationId: receipt.evaluation.id, targetRevision: receipt.revision, retryEpoch: null, hadEffects: false } };
          return { status: 202, data: { evaluationId: receipt.evaluation.id, targetRevision: receipt.revision,
            ...(receipt.evaluation.status === "unavailable" ? await retryIdentity(tx, receipt.evaluation.id, receipt.revision) : { retryEpoch: null, hadEffects: false }) } };
        });
      });
      if (reference.data.retryEpoch !== null) await activateLearningJob(transactions, admission, actor, { kind: "evaluation", evaluationId: reference.data.evaluationId, targetEvaluationRevision: reference.data.targetRevision }, { retryReceiptId: command.key, expectedRetryEpoch: reference.data.retryEpoch, hadEffects: reference.data.hadEffects });
      return transactions.run(async (tx) => {
        const enrollment = await repository.requireEnrollment(tx, actor, await repository.attemptEnrollmentId(tx, actor, attemptId));
        const receipt = await repository.readEvaluation(tx, enrollment, attemptId);
        return { status: receipt.evaluation.status === "pending" ? 202 as const : 200 as const, data: receipt };
      });
    },
    async retryReview(actor: Actor, attemptId: string, reviewId: string, command: LearningCommand<z.infer<typeof EvaluationRevisionInputSchema>>) {
      parse(IdSchema, attemptId); parse(IdSchema, reviewId); parse(IdSchema, command.key); const body = parse(EvaluationRevisionInputSchema, command.body);
      const reference = await transactions.run(async (tx) => {
        await lockAttempt(tx, actor, attemptId);
        return executeIdempotentInTransaction(tx, actor, { operation: "learning.review.retry", key: command.key, body: { attemptId, reviewId, ...body }, parseResult: retryReference }, async () => {
          const receipt = await readReview(tx, actor, attemptId, reviewId);
          if (receipt.evaluation.revision !== body.expectedEvaluationRevision || receipt.review.expectedEvaluationRevision !== body.expectedEvaluationRevision || receipt.review.status === "superseded") repository.revisionConflict(receipt.evaluation.revision, "learning.evaluationChanged");
          return { status: 202, data: { evaluationId: receipt.review.evaluationId, targetRevision: receipt.review.expectedEvaluationRevision + 1,
            ...(receipt.review.status === "unavailable" ? await retryIdentity(tx, receipt.review.evaluationId, receipt.review.expectedEvaluationRevision + 1) : { retryEpoch: null, hadEffects: false }) } };
        });
      });
      if (reference.data.retryEpoch !== null) await activateLearningJob(transactions, admission, actor, { kind: "evaluation", evaluationId: reference.data.evaluationId, targetEvaluationRevision: reference.data.targetRevision }, { retryReceiptId: command.key, expectedRetryEpoch: reference.data.retryEpoch, hadEffects: reference.data.hadEffects });
      return { status: 202 as const, data: await transactions.run((tx) => readReview(tx, actor, attemptId, reviewId)) };
    },
  };
}
