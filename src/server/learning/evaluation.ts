import "server-only";
import { EvaluationSchema, PersonalRouteSchema, type Enrollment } from "@/domain/learning";
import type { TaskPrivate, TaskPublic } from "@/domain/mechanics";
import type { DbTransaction } from "@/server/db";
import { applyEvaluationProgressTx, previewEvaluationAwardTx } from "@/server/progression";
import { GradeDecisionSchema, type AuthoritativeActivity, type GradeDecision } from "@/server/evaluation/contracts";
import { deriveCriterionCoverage, evidenceObservation, mapCanonicalDimensions } from "./evidence";
import * as repository from "./repository";
import { maybeOfferAutomaticSupportTx, returnSupportTx } from "./support";

/** Caller retains the stable-task -> enrollment -> activity -> evaluation lock chain. */
export async function commitSemanticEvaluationTx(tx: DbTransaction, input: {
  enrollment: Enrollment; task: TaskPublic; privateTask: TaskPrivate; activity: AuthoritativeActivity;
  attemptId: string; evaluationId: string; revision: number; decision: GradeDecision;
}, createId: () => string) {
  const decision = GradeDecisionSchema.parse(input.decision);
  if (decision.status === "unavailable") repository.invariant();
  const awardedXp = await previewEvaluationAwardTx(tx, { attemptId: input.attemptId, evaluationId: input.evaluationId,
    evaluationRevision: input.revision, status: decision.status, outcome: decision.outcome });
  const evaluation = EvaluationSchema.parse({ id: input.evaluationId, attemptId: input.attemptId, ...decision, awardedXp });
  await tx.query(`INSERT INTO unfurl.evaluation_revisions(evaluation_id,attempt_id,revision,status,outcome,dimensions,feedback,awarded_xp)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [evaluation.id, evaluation.attemptId, input.revision, evaluation.status,
    evaluation.outcome, JSON.stringify(evaluation.dimensions), JSON.stringify(evaluation.feedback), evaluation.awardedXp]);
  const canonical = mapCanonicalDimensions(input.privateTask.assessment, decision);
  await tx.query("UPDATE unfurl.learner_evidence SET review_state='superseded' WHERE evaluation_id=$1 AND evaluation_revision<>$2", [evaluation.id, input.revision]);
  for (const mapped of canonical) {
    const context = { evaluationId: evaluation.id, evaluationRevision: input.revision, taskId: input.task.id, taskVersion: input.task.taskVersion,
      evidenceGroupId: input.privateTask.assessment.evidenceGroupId, assistance: input.activity.assistance,
      dimensionStatuses: mapped.dimensionStatuses, reviewState: "confirmed" };
    await tx.query(`INSERT INTO unfurl.learner_evidence
      (id,enrollment_id,outcome_id,source,observation,dimension_ids,context,attempt_id,evaluation_id,evaluation_revision,task_id,task_version,evidence_group_id,assistance,review_state)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,'confirmed')`,
    [createId(), input.enrollment.id, mapped.outcomeId, JSON.stringify({ kind: "attempt", attemptId: input.attemptId }),
      evidenceObservation(mapped.dimensionStatuses, input.activity.assistance), Object.keys(mapped.dimensionStatuses), JSON.stringify(context),
      input.attemptId, input.evaluationId, input.revision, input.task.id, input.task.taskVersion, input.privateTask.assessment.evidenceGroupId, input.activity.assistance]);
  }
  const updated = await tx.query(`UPDATE unfurl.evaluations SET revision=$2,status=$3,outcome=$4,dimensions=$5::jsonb,feedback=$6::jsonb,awarded_xp=$7,updated_at=now()
    WHERE id=$1 AND attempt_id=$8 AND revision=$9 AND ($2<>1 OR status IN ('pending','unavailable')) RETURNING id`,
    [evaluation.id, input.revision, evaluation.status, evaluation.outcome, JSON.stringify(evaluation.dimensions), JSON.stringify(evaluation.feedback), evaluation.awardedXp,
      input.attemptId, Math.max(1, input.revision - 1)]);
  if (updated.rowCount !== 1) repository.revisionConflict(input.revision, "learning.evaluationChanged");
  await applyEvaluationProgressTx(tx, { evaluationId: evaluation.id, evaluationRevision: input.revision });
  const current = await refreshCoverageTx(tx, input.enrollment);
  const offer = await repository.readSupport(tx, input.enrollment);
  if (offer?.status === "accepted" && offer.completionCheck?.taskId === input.task.id && input.enrollment.currentTaskId === input.task.id) {
    const submitted = (await tx.query<{ submitted_route_revision: number }>("SELECT submitted_route_revision FROM unfurl.attempts WHERE id=$1", [input.attemptId])).rows[0];
    // Historical or review completions must not close a later support position.
    if (submitted?.submitted_route_revision === input.enrollment.routeRevision && input.revision === 1) {
      const target = canonical.find(({ outcomeId }) => outcomeId === offer.target.outcomeId);
      const completed = decision.status === "evaluated" && offer.completionCheck.dimensionIds.every((id) => target?.dimensionStatuses[id] === "met");
      await returnSupportTx(tx, current, offer, completed ? "completed" : "returned");
    }
  }
  if (!offer && input.revision === 1 && decision.status === "evaluated") await maybeOfferAutomaticSupportTx(tx, current, createId);
  return evaluation;
}

/** Coverage can change after a late result; this never moves the learner's current position. */
export async function refreshCoverageTx(tx: DbTransaction, enrollment: Enrollment): Promise<Enrollment> {
  const route = await repository.requireRoute(tx, enrollment);
  const program = await repository.loadProgram(tx, enrollment);
  const evidence = await repository.readEvidence(tx, enrollment);
  const traversedLessonIds = (await tx.query<{ lesson_id: string }>("SELECT lesson_id FROM unfurl.enrollment_lesson_traversal WHERE enrollment_id=$1 AND course_version_id=$2", [enrollment.id, enrollment.courseVersionId])).rows.map(({ lesson_id }) => lesson_id);
  const coverage = deriveCriterionCoverage({ enrollmentId: enrollment.id, ...program, evidence, traversedLessonIds });
  const changed = JSON.stringify(route.coveredOutcomeIds) !== JSON.stringify(coverage.coveredOutcomeIds) || JSON.stringify(route.pendingOutcomeIds) !== JSON.stringify(coverage.pendingOutcomeIds);
  const revised = PersonalRouteSchema.parse({ ...route, revision: route.revision + (changed ? 1 : 0), coveredOutcomeIds: coverage.coveredOutcomeIds, pendingOutcomeIds: coverage.pendingOutcomeIds });
  if (changed) await tx.query("UPDATE unfurl.personal_routes SET revision=$2,document=$3::jsonb,updated_at=now() WHERE enrollment_id=$1", [enrollment.id, revised.revision, JSON.stringify(revised)]);
  const completed = coverage.completed && !route.next.some(({ reasonCode }) => reasonCode === "course_sequence");
  await tx.query("UPDATE unfurl.enrollments SET route_revision=$2,status=CASE WHEN status='archived' THEN status WHEN $3::boolean THEN 'completed' ELSE 'active' END WHERE id=$1", [enrollment.id, revised.revision, completed]);
  return { ...enrollment, routeRevision: revised.revision, status: enrollment.status === "archived" ? "archived" : completed ? "completed" : "active" };
}
