import "server-only";
import { z } from "zod";
import { IdSchema } from "@/domain/common";
import { PersonalRouteSchema, type Enrollment } from "@/domain/learning";
import { RouteRevisionInputSchema, type LearningContext } from "@/application/learning-port";
import type { Actor } from "@/server/auth/actor";
import { ServiceFault } from "@/server/auth/errors";
import type { DbTransaction } from "@/server/db";
import { executeIdempotentInTransaction } from "@/server/idempotency";
import { selectFreshAssessment } from "@/server/adaptation/fresh-assessment";
import { activityBudgetLimit, invalidLearningFields } from "./actions";
import { uncoveredRequiredCriteria } from "./evidence";
import { projectLearningSession } from "./projection";
import type { LearningCommand, LearningTransactions } from "./service";
import * as repository from "./repository";

export async function loadFreshAssessmentChoice(tx: DbTransaction, enrollment: Enrollment, program?: Awaited<ReturnType<typeof repository.loadProgram>>) {
  const material = program ?? await repository.loadProgram(tx, enrollment);
  const evidence = await repository.readEvidence(tx, enrollment);
  const uncovered = uncoveredRequiredCriteria({ enrollmentId: enrollment.id, ...material, evidence });
  const current = material.tasks.find(({ task }) => task.id === enrollment.currentTaskId);
  const relevant = current ? new Map(current.assessment.outcomes.map(({ outcomeId, dimensions }) =>
    [outcomeId, new Set(dimensions.map(({ dimensionId }) => dimensionId).filter((id) => uncovered.get(outcomeId)?.has(id)))])) : uncovered;
  const outcomeIds = [...relevant].filter(([, dimensions]) => dimensions.size > 0).map(([id]) => id);
  const support = await repository.readSupport(tx, enrollment);
  const pending = (await tx.query(`SELECT 1 FROM unfurl.attempts a JOIN unfurl.evaluations v ON v.attempt_id=a.id
    WHERE a.enrollment_id=$1 AND (v.status='pending' OR EXISTS (
      SELECT 1 FROM unfurl.assessment_review_requests r WHERE r.attempt_id=a.id AND r.status IN ('queued','running')) OR EXISTS (
      SELECT 1 FROM unfurl.execution_jobs j WHERE j.evaluation_id=v.id AND j.status IN ('queued','running'))) LIMIT 1`, [enrollment.id])).rows.length > 0;
  const blockedReason = enrollment.status === "archived" ? "archived" as const : support ? "support_active" as const : pending ? "review_active" as const : null;
  let choice: ReturnType<typeof selectFreshAssessment> = null;
  if (!blockedReason && outcomeIds.length > 0) {
    // Treat any started activity, disclosed assistance or support reference as exposure, including other enrollments/versions.
    const exposed = (await tx.query<{ task_id: string; evidence_group_id: string }>(`WITH used AS (
      SELECT s.task_id,s.task_version FROM unfurl.activity_sessions s JOIN unfurl.enrollments e ON e.id=s.enrollment_id WHERE e.learner_id=$1 AND e.course_id=$2
      UNION SELECT a.task_id,a.task_version FROM unfurl.attempts a JOIN unfurl.enrollments e ON e.id=a.enrollment_id WHERE e.learner_id=$1 AND e.course_id=$2
      UNION SELECT h.task_id,h.task_version FROM unfurl.hint_usage h JOIN unfurl.enrollments e ON e.id=h.enrollment_id WHERE e.learner_id=$1 AND e.course_id=$2
      UNION SELECT t.task_id,t.task_version FROM unfurl.support_offer_tasks t JOIN unfurl.support_offers o ON o.id=t.offer_id JOIN unfurl.enrollments e ON e.id=o.enrollment_id WHERE e.learner_id=$1 AND e.course_id=$2 AND o.status IN ('accepted','returned','completed')
      UNION SELECT t.id,t.task_version FROM unfurl.enrollments e JOIN unfurl.tasks_public t ON t.id=e.current_task_id AND t.course_version_id=e.course_version_id WHERE e.learner_id=$1 AND e.course_id=$2
    ) SELECT DISTINCT u.task_id,p.assessment->>'evidenceGroupId' AS evidence_group_id FROM used u
      JOIN unfurl.tasks_private p ON p.task_id=u.task_id AND p.task_version=u.task_version`, [enrollment.learnerId, enrollment.courseId])).rows;
    choice = selectFreshAssessment({ enrollmentId: enrollment.id, ...material, evidence, targetCriteria: relevant,
      exposedTaskIds: new Set(exposed.map(({ task_id }) => task_id)), exposedGroupIds: new Set(exposed.map(({ evidence_group_id }) => evidence_group_id)) });
  }
  const availability: LearningContext["freshAssessment"] = { availability: blockedReason ? "blocked" : outcomeIds.length === 0 ? "not_needed" : choice ? "available" : "no_unseen_assessment", blockedReason, outcomeIds: choice?.outcomeIds ?? outcomeIds };
  return { availability, choice };
}

export function createFreshAssessmentOperations(transactions: LearningTransactions, createId: () => string) {
  return {
    requestFreshAssessment(actor: Actor, enrollmentId: string, command: LearningCommand<z.infer<typeof RouteRevisionInputSchema>>) {
      const checked = z.object({ enrollmentId: IdSchema, key: IdSchema, body: RouteRevisionInputSchema }).strict().safeParse({ enrollmentId, ...command });
      if (!checked.success) throw invalidLearningFields(checked.error.issues);
      return transactions.run(async (tx) => {
        const owned = await repository.requireEnrollment(tx, actor, enrollmentId);
        // Exposure checks serialize with activity/assistance writes in every existing enrollment of this course.
        await tx.query("SELECT id FROM unfurl.enrollments WHERE learner_id=$1 AND course_id=$2 ORDER BY id FOR UPDATE", [actor.id, owned.courseId]);
        const enrollment = await repository.requireEnrollment(tx, actor, enrollmentId);
        await executeIdempotentInTransaction(tx, actor, { operation: "learning.fresh_assessment", key: command.key,
          body: { enrollmentId, ...checked.data.body }, parseResult: z.object({ enrollmentId: IdSchema }).strict() }, async () => {
          if (enrollment.routeRevision !== checked.data.body.expectedRouteRevision) repository.revisionConflict(enrollment.routeRevision);
          const route = await repository.requireRoute(tx, enrollment);
          const { availability, choice } = await loadFreshAssessmentChoice(tx, enrollment);
          if (!choice) throw new ServiceFault(409, "revision_conflict", availability.availability === "blocked" ? `learning.freshAssessment.${availability.blockedReason}` :
            availability.availability === "not_needed" ? "learning.freshAssessment.notNeeded" : "learning.freshAssessment.noUnseenAssessment", false, { currentRevision: enrollment.routeRevision });
          const tail = route.next[0]?.reasonCode === "scheduled_review" ? route.next.slice(1) : route.next;
          const revised = PersonalRouteSchema.parse({ ...route, revision: route.revision + 1, next: [choice.position, ...tail] });
          await tx.query(`INSERT INTO unfurl.activity_sessions(id,enrollment_id,task_id,task_version,hidden_state,action_budget,actions_used,status,revision,input_revision)
            VALUES($1,$2,$3,$4,'{}'::jsonb,$5,0,'active',1,0)`, [createId(), enrollmentId, choice.entry.task.id, choice.entry.task.taskVersion, activityBudgetLimit(choice.entry.task)]);
          await tx.query("UPDATE unfurl.personal_routes SET revision=$2,document=$3::jsonb,updated_at=now() WHERE enrollment_id=$1", [enrollmentId, revised.revision, JSON.stringify(revised)]);
          await tx.query("UPDATE unfurl.enrollments SET route_revision=$2,current_lesson_id=$3,current_task_id=$4,status='active',last_studied_at=now() WHERE id=$1", [enrollmentId, revised.revision, choice.position.lessonId, choice.position.taskId]);
          return { status: 200, data: { enrollmentId } };
        });
        return { status: 200 as const, data: await projectLearningSession(tx, await repository.requireEnrollment(tx, actor, enrollmentId)) };
      });
    },
  };
}
