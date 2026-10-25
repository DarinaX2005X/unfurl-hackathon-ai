import "server-only";
import { IdSchema, type Id } from "@/domain/common";
import { CourseVersionSchema, type CourseVersion } from "@/domain/course";
import { LessonSchema, PersonalRouteSchema, type Lesson, type PersonalRoute } from "@/domain/learning";
import { TaskAssessmentSchema, TaskPublicSchema, type TaskAssessment, type TaskPublic } from "@/domain/mechanics";

export type AssessedTask = { task: TaskPublic; assessment: TaskAssessment };
export type InitialLearningRoute = {
  route: PersonalRoute; currentLessonId: Id; currentTaskId: Id | null;
};

function unique(values: readonly string[], label: string): Set<string> {
  const ids = new Set(values);
  if (ids.size !== values.length) throw new Error(`Duplicate ${label}`);
  return ids;
}
function sameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const ids = unique(actual, label);
  const expectedIds = unique(expected, label);
  if (ids.size !== expectedIds.size || expected.some((id) => !ids.has(id))) throw new Error(`Mismatched ${label}`);
}

/** Called by enrollment creation in its transaction, never by a read or reactivation. */
export function createInitialLearningRoute(input: {
  enrollmentId: Id; version: CourseVersion; lessons: readonly Lesson[]; tasks: readonly AssessedTask[];
}): InitialLearningRoute {
  const enrollmentId = IdSchema.parse(input.enrollmentId);
  const version = CourseVersionSchema.parse(input.version);
  if (version.state !== "ready") throw new Error("Learning requires a ready pinned version");
  const { next, targetOutcomeIds } = createNormalProgramEntries(input);
  const route = PersonalRouteSchema.parse({ enrollmentId, revision: 1, policyVersion: "adaptation-v1",
    targetOutcomeIds, next, coveredOutcomeIds: [], pendingOutcomeIds: targetOutcomeIds });
  return { route, currentLessonId: next[0]!.lessonId, currentTaskId: next[0]!.taskId };
}

/** Shared traversal validation for persisted generation candidates, without a fabricated learner enrollment. */
export function createNormalProgramEntries(input: {
  version: CourseVersion; lessons: readonly Lesson[]; tasks: readonly AssessedTask[];
}): { next: PersonalRoute["next"]; targetOutcomeIds: Id[] } {
  const version = CourseVersionSchema.parse(input.version);
  if (!["building", "validating", "ready"].includes(version.state)) throw new Error("Only a current course version can define a normal program");
  const lessons = input.lessons.map((lesson) => LessonSchema.parse(lesson));
  sameSet(lessons.map((lesson) => lesson.id), version.lessonIds, "version lessons");
  const outcomes = unique(version.outcomes.map((outcome) => outcome.id), "version outcomes");
  const modules = unique(version.modules.map((module) => module.id), "version modules");
  const tasks = input.tasks.map(({ task, assessment }) => ({ task: TaskPublicSchema.parse(task), assessment: TaskAssessmentSchema.parse(assessment) }));
  unique(tasks.map(({ task }) => task.id), "task IDs");
  const byTask = new Map(tasks.map((entry) => [entry.task.id, entry]));
  const byLesson = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const usedTasks: string[] = [];
  const next: PersonalRoute["next"] = [];
  const assessedRequired = new Set<string>();
  for (const lessonId of version.lessonIds) {
    const lesson = byLesson.get(lessonId)!;
    if (lesson.courseVersionId !== version.id || !modules.has(lesson.moduleId) || lesson.outcomeIds.some((id) => !outcomes.has(id))) {
      throw new Error("Lesson does not belong to this version's program");
    }
    unique(lesson.blocks.map((block) => block.id), "lesson blocks");
    const blockTasks = lesson.blocks.flatMap((block) => block.kind === "task" ? [block.taskId] : []);
    sameSet(blockTasks, lesson.taskIds, "lesson task blocks");
    usedTasks.push(...blockTasks);
    let requiredCount = 0;
    for (const taskId of blockTasks) {
      const entry = byTask.get(taskId);
      if (!entry) throw new Error("Missing assessed lesson task");
      sameSet(entry.task.outcomeIds, entry.assessment.outcomes.map((outcome) => outcome.outcomeId), "task assessment outcomes");
      if (entry.task.outcomeIds.some((id) => !outcomes.has(id) || !lesson.outcomeIds.includes(id))) throw new Error("Task outcome is outside its lesson");
      if (entry.assessment.role !== "required") continue;
      entry.assessment.outcomes.forEach(({ outcomeId }) => assessedRequired.add(outcomeId));
      next.push({ lessonId, taskId, reasonCode: "course_sequence", basisEvidenceIds: [] });
      requiredCount += 1;
    }
    if (requiredCount === 0) {
      if (!lesson.blocks.some((block) => block.kind === "explanation" || block.kind === "example")) throw new Error("A normal lesson needs required practice or reading material");
      next.push({ lessonId, taskId: null, reasonCode: "course_sequence", basisEvidenceIds: [] });
    }
  }
  sameSet(usedTasks, tasks.map(({ task }) => task.id), "version task membership");
  if ([...outcomes].some((id) => !assessedRequired.has(id))) throw new Error("Every approved outcome needs required assessment criteria");
  if (next.length === 0) throw new Error("A normal program needs at least one position");
  return { next, targetOutcomeIds: [...outcomes] };
}
