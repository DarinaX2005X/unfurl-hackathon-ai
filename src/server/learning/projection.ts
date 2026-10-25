import "server-only";
import { LearningSessionSchema, type Enrollment, type LearningSession } from "@/domain/learning";
import type { DbTransaction } from "@/server/db";
import { readAccountProgressTx } from "@/server/progression";
import { deriveCriterionCoverage } from "./evidence";
import { createInitialLearningRoute } from "./initial-route";
import * as repository from "./repository";

export async function projectLearningSession(tx: DbTransaction, enrollment: Enrollment): Promise<LearningSession> {
  const route = await repository.requireRoute(tx, enrollment);
  const program = await repository.loadProgram(tx, enrollment);
  createInitialLearningRoute({ enrollmentId: enrollment.id, ...program });
  if (route.targetOutcomeIds.length !== program.version.outcomes.length ||
    program.version.outcomes.some(({ id }) => !route.targetOutcomeIds.includes(id))) repository.invariant();
  let lesson = enrollment.currentLessonId === null ? null : program.lessons.find(({ id }) => id === enrollment.currentLessonId) ?? repository.invariant();
  const task = enrollment.currentTaskId === null ? null : program.tasks.find(({ task }) => task.id === enrollment.currentTaskId)?.task ?? repository.invariant();
  if (task && (!lesson || !lesson.taskIds.includes(task.id))) repository.invariant();
  const state = task ? await repository.findActivity(tx, enrollment, task.id, task.taskVersion) : null;
  const attempt = state ? await repository.latestTaskAttempt(tx, enrollment, state.activity) : null;
  const evaluation = attempt ? await repository.readEvaluation(tx, enrollment, attempt.id) : null;
  const evidence = await repository.readEvidence(tx, enrollment);
  const traversedLessonIds = (await tx.query<{ lesson_id: string }>("SELECT lesson_id FROM unfurl.enrollment_lesson_traversal WHERE enrollment_id=$1 AND course_version_id=$2", [enrollment.id, enrollment.courseVersionId])).rows.map(({ lesson_id }) => lesson_id);
  const coverage = deriveCriterionCoverage({ enrollmentId: enrollment.id, ...program, evidence, traversedLessonIds });
  const account = await readAccountProgressTx(tx, enrollment.learnerId);
  const support = await repository.readSupport(tx, enrollment);
  if (support) {
    if (support.courseVersionId !== enrollment.courseVersionId || !program.lessons.some(({ id }) => id === support.returnPoint.lessonId)) repository.invariant();
    for (const reference of support.tasks) {
      const candidate = program.tasks.find(({ task }) => task.id === reference.taskId && task.taskVersion === reference.taskVersion);
      if (!candidate || candidate.assessment.role === "required" || !program.lessons.some((item) => item.id === reference.lessonId && item.taskIds.includes(reference.taskId))) repository.invariant();
    }
    if (support.explanationBlock && !program.lessons.some((item) => item.id === support.explanationBlock!.lessonId &&
      item.blocks.some((block) => block.id === support.explanationBlock!.blockId && block.kind === "explanation"))) repository.invariant();
    if (support.status === "accepted" && enrollment.currentTaskId === null && lesson && lesson.id === support.explanationBlock?.lessonId) {
      lesson = { ...lesson, blocks: lesson.blocks.filter(({ id }) => id === support.explanationBlock!.blockId), taskIds: [] };
    }
  }
  return LearningSessionSchema.parse({ enrollment, route: { ...route, coveredOutcomeIds: coverage.coveredOutcomeIds, pendingOutcomeIds: coverage.pendingOutcomeIds },
    lesson, task, progress: { ...account, completedRequiredOutcomes: coverage.completedRequiredOutcomes, totalRequiredOutcomes: coverage.totalRequiredOutcomes },
    activity: state?.activity ?? null, savedInput: state?.savedInput ?? null, evaluation, support });
}
