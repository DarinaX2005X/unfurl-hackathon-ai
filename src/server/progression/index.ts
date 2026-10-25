import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { IdSchema, RevisionSchema, type Id, type Revision } from "../../domain/common";
import { AccountProgressSchema, type AccountProgress } from "../../domain/learning";
import { ServiceFault } from "../auth/errors";
import { withSystemTransaction, type DbTransaction } from "../db";
import { accountProgressForXp, correctedContribution, initialAwardAmount, XP_POLICY_VERSION } from "./policy";

const StableTaskIdentitySchema = z.object({
  learnerId: IdSchema,
  courseId: IdSchema,
  taskId: IdSchema,
}).strict();
const EvaluationProgressInputSchema = z.object({
  evaluationId: IdSchema,
  evaluationRevision: RevisionSchema,
}).strict();

export type StableTaskIdentity = z.infer<typeof StableTaskIdentitySchema>;
export type EvaluationProgressInput = z.infer<typeof EvaluationProgressInputSchema>;

type Assistance = "independent" | "hinted" | "worked_example";
type SemanticStatus = "evaluated" | "uncertain";
type Outcome = "correct" | "partial" | "incorrect" | null;
type EvaluationIdentityRow = {
  evaluation_id: string;
  current_revision: number;
  attempt_id: string;
  learner_id: string;
  enrollment_id: string;
  activity_session_id: string;
  course_id: string;
  task_id: string;
  assistance: Assistance;
  semantic_status: SemanticStatus;
  semantic_outcome: Outcome;
};
type EvidenceRow = { id: string; assistance: Assistance; review_state: "confirmed" | "contested" | "superseded" };
type AwardRow = {
  id: string;
  amount: 10 | 25;
  qualifying_evidence_id: string;
  original_evaluation_id: string;
};

function invariant(message: string): never {
  throw new ServiceFault(503, "service_unavailable", message, true);
}

/** Shared by learning before it locks enrollment/activity/evaluation rows. */
export async function lockLearnerCourseStableTaskTx(tx: DbTransaction, value: StableTaskIdentity): Promise<void> {
  const identity = StableTaskIdentitySchema.parse(value);
  const digest = createHash("sha256")
    .update("unfurl.progression.stable-task.v1\0")
    .update(identity.learnerId).update("\0")
    .update(identity.courseId).update("\0")
    .update(identity.taskId)
    .digest();
  const key = digest.readBigInt64BE(0).toString();
  await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
}

const identitySql = `
  SELECT evaluation.id AS evaluation_id, evaluation.revision AS current_revision,
    attempt.id AS attempt_id, attempt.learner_id, attempt.enrollment_id,
    attempt.activity_session_id, enrollment.course_id, attempt.task_id, attempt.assistance,
    semantic.status AS semantic_status, semantic.outcome AS semantic_outcome
  FROM unfurl.evaluations evaluation
  JOIN unfurl.attempts attempt ON attempt.id = evaluation.attempt_id
  JOIN unfurl.enrollments enrollment
    ON enrollment.id = attempt.enrollment_id
    AND enrollment.learner_id = attempt.learner_id
    AND enrollment.course_version_id = attempt.course_version_id
  JOIN unfurl.evaluation_revisions semantic
    ON semantic.evaluation_id = evaluation.id
    AND semantic.attempt_id = attempt.id
    AND semantic.revision = $2
  WHERE evaluation.id = $1`;

async function readEvaluationIdentity(
  tx: DbTransaction,
  input: EvaluationProgressInput,
  lock: boolean,
): Promise<EvaluationIdentityRow | null> {
  const result = await tx.query<EvaluationIdentityRow>(`${identitySql}${lock ? " FOR UPDATE OF evaluation" : ""}`, [
    input.evaluationId,
    input.evaluationRevision,
  ]);
  return result.rows[0] ?? null;
}

export async function applyEvaluationProgressTx(
  tx: DbTransaction,
  value: { evaluationId: Id; evaluationRevision: Revision },
): Promise<void> {
  const input = EvaluationProgressInputSchema.parse(value);
  const observed = await readEvaluationIdentity(tx, input, false);
  if (!observed || observed.current_revision !== input.evaluationRevision) return;

  const stableIdentity = StableTaskIdentitySchema.parse({
    learnerId: observed.learner_id,
    courseId: observed.course_id,
    taskId: observed.task_id,
  });
  await lockLearnerCourseStableTaskTx(tx, stableIdentity);

  const enrollment = await tx.query<{ id: string }>(
    `SELECT id FROM unfurl.enrollments
     WHERE id = $1 AND learner_id = $2 AND course_id = $3 FOR UPDATE`,
    [observed.enrollment_id, observed.learner_id, observed.course_id],
  );
  if (!enrollment.rows[0]) invariant("progress.storageInvariant");

  const activity = await tx.query<{ id: string }>(
    `SELECT id FROM unfurl.activity_sessions
     WHERE id = $1 AND enrollment_id = $2 AND task_id = $3 FOR UPDATE`,
    [observed.activity_session_id, observed.enrollment_id, observed.task_id],
  );
  if (!activity.rows[0]) invariant("progress.storageInvariant");

  const current = await readEvaluationIdentity(tx, input, true);
  if (!current || current.current_revision !== input.evaluationRevision) return;
  if (
    current.learner_id !== observed.learner_id
    || current.course_id !== observed.course_id
    || current.task_id !== observed.task_id
    || current.activity_session_id !== observed.activity_session_id
  ) invariant("progress.storageInvariant");

  const evidence = (await tx.query<EvidenceRow>(
    `SELECT id, assistance, review_state FROM unfurl.learner_evidence
     WHERE evaluation_id = $1 AND evaluation_revision = $2
       AND attempt_id = $3 AND enrollment_id = $4 AND task_id = $5
     ORDER BY id`,
    [input.evaluationId, input.evaluationRevision, current.attempt_id, current.enrollment_id, current.task_id],
  )).rows;
  if (!evidence.length) return;
  if (evidence.some((row) => row.assistance !== current.assistance)) invariant("progress.storageInvariant");

  const award = (await tx.query<AwardRow>(
    `SELECT award.id, award.amount, award.qualifying_evidence_id,
       original_evidence.evaluation_id AS original_evaluation_id
     FROM unfurl.xp_awards award
     JOIN unfurl.learner_evidence original_evidence ON original_evidence.id = award.qualifying_evidence_id
     WHERE award.learner_id = $1 AND award.course_id = $2 AND award.task_id = $3
     FOR UPDATE OF award`,
    [current.learner_id, current.course_id, current.task_id],
  )).rows[0];

  if (award) {
    if (award.original_evaluation_id !== input.evaluationId) return;
    if (current.semantic_status !== "evaluated" || evidence.some((row) => row.review_state !== "confirmed")) return;
    const originalAmount = award.amount;
    const target = correctedContribution({ status: current.semantic_status, outcome: current.semantic_outcome }, originalAmount);
    if (target === null) return;
    const adjustmentResult = await tx.query<{ delta_total: string | number }>(
      `SELECT COALESCE(sum(delta), 0)::bigint::text AS delta_total
       FROM unfurl.xp_award_adjustments WHERE award_id = $1`,
      [award.id],
    );
    const adjustmentTotal = Number(adjustmentResult.rows[0]?.delta_total ?? 0);
    const contribution = originalAmount + adjustmentTotal;
    if (contribution !== 0 && contribution !== originalAmount) invariant("progress.storageInvariant");
    const delta = target - contribution;
    if (delta === 0) return;
    if (![10, 25, -10, -25].includes(delta)) invariant("progress.storageInvariant");
    await tx.query(
      `INSERT INTO unfurl.xp_award_adjustments
        (id, award_id, evaluation_id, evaluation_revision, delta, reason)
       VALUES ($1, $2, $3, $4, $5, 'evaluation_corrected')
       ON CONFLICT (award_id, evaluation_revision) DO NOTHING`,
      [randomUUID(), award.id, input.evaluationId, input.evaluationRevision, delta],
    );
    return;
  }

  if (evidence.some((row) => row.review_state !== "confirmed")) return;
  const amount = initialAwardAmount({
    status: current.semantic_status,
    outcome: current.semantic_outcome,
    assistance: current.assistance,
  });
  if (amount === 0) return;
  await tx.query(
    `INSERT INTO unfurl.xp_awards
      (id, learner_id, course_id, task_id, qualifying_evidence_id, policy_version, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), current.learner_id, current.course_id, current.task_id, evidence[0]!.id, XP_POLICY_VERSION, amount],
  );
}

export async function readAccountProgressTx(tx: DbTransaction, learnerId: Id): Promise<AccountProgress> {
  const id = IdSchema.parse(learnerId);
  const result = await tx.query<{ xp_total: string | number }>(
    `SELECT COALESCE(sum(award.amount + COALESCE(adjustment.delta_total, 0)), 0)::bigint::text AS xp_total
     FROM unfurl.xp_awards award
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(item.delta), 0) AS delta_total
       FROM unfurl.xp_award_adjustments item WHERE item.award_id = award.id
     ) adjustment ON true
     WHERE award.learner_id = $1`,
    [id],
  );
  const raw = result.rows[0]?.xp_total ?? 0;
  const total = typeof raw === "number" ? raw : Number(raw);
  return AccountProgressSchema.parse(accountProgressForXp(total));
}

export function readAccountProgress(learnerId: Id): Promise<AccountProgress> {
  const id = IdSchema.parse(learnerId);
  return withSystemTransaction("learning_activity", (tx) => readAccountProgressTx(tx, id));
}
