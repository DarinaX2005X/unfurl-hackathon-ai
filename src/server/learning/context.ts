import "server-only";
import { z } from "zod";
import { IdSchema, RevisionSchema } from "@/domain/common";
import type { Enrollment } from "@/domain/learning";
import { LearningContextQuerySchema, LearningContextSchema, type LearningContext, type LearningContextQuery } from "@/application/learning-port";
import type { DbTransaction } from "@/server/db";
import { ServiceFault } from "@/server/auth/errors";
import { createInitialLearningRoute } from "./initial-route";
import * as repository from "./repository";
import { loadFreshAssessmentChoice } from "./fresh-assessment";

const CursorSchema = z.object({ versionId: IdSchema, routeRevision: RevisionSchema, index: z.number().int().nonnegative() }).strict();
export async function projectLearningContext(tx: DbTransaction, enrollment: Enrollment, query: LearningContextQuery): Promise<LearningContext> {
  const value = LearningContextQuerySchema.parse(query);
  const program = await repository.loadProgram(tx, enrollment);
  const route = await repository.requireRoute(tx, enrollment);
  const normal = createInitialLearningRoute({ enrollmentId: enrollment.id, ...program }).route;
  const traversed = new Set((await tx.query<{ lesson_id: string }>("SELECT lesson_id FROM unfurl.enrollment_lesson_traversal WHERE enrollment_id=$1 AND course_version_id=$2", [enrollment.id, enrollment.courseVersionId])).rows.map(({ lesson_id }) => lesson_id));
  let index = 0;
  if (value.cursor) {
    let cursor: z.infer<typeof CursorSchema>;
    try { cursor = CursorSchema.parse(JSON.parse(Buffer.from(value.cursor, "base64url").toString("utf8"))); }
    catch { throw new ServiceFault(400, "invalid_input", "learning.invalidContextCursor"); }
    if (cursor.versionId !== program.version.id || cursor.routeRevision !== route.revision) repository.revisionConflict(route.revision);
    if (cursor.index >= program.version.lessonIds.length) throw new ServiceFault(400, "invalid_input", "learning.invalidContextCursor");
    index = cursor.index;
  }
  const lessonIds = program.version.lessonIds.slice(index, index + (value.limit ?? 50));
  const currentLesson = program.lessons.find(({ id }) => id === enrollment.currentLessonId);
  const currentTask = program.tasks.find(({ task }) => task.id === enrollment.currentTaskId)?.task;
  const sourceIds = [...new Set(currentLesson?.blocks.flatMap((block) => block.kind === "task" ? [] : block.sourceIds) ?? [])];
  const sources = sourceIds.length === 0 ? [] : (await tx.query(`SELECT id,title,final_url,retrieved_at FROM unfurl.research_source_documents WHERE id=ANY($1::uuid[])`, [sourceIds])).rows;
  let assistance: LearningContext["assistance"] = null;
  if (currentTask) {
    const privateTask = await repository.loadPrivateTask(tx, enrollment, currentTask.id, currentTask.taskVersion);
    const ledger = await repository.readAssistance(tx, enrollment, currentTask.id);
    const usage = (await tx.query("SELECT id,kind,hint_index,created_at FROM unfurl.hint_usage WHERE enrollment_id=$1 AND task_id=$2 AND task_version=$3 ORDER BY created_at,id", [enrollment.id, currentTask.id, currentTask.taskVersion])).rows;
    const worked = usage.find((row) => row.kind === "worked_example");
    assistance = { taskId: currentTask.id, taskVersion: currentTask.taskVersion, level: ledger.assistance,
      hints: usage.filter((row) => row.kind === "hint").map((row) => ({ hintId: row.id, index: row.hint_index,
        content: privateTask.hints[row.hint_index] ?? repository.invariant(), usedAt: repository.storedTime(row.created_at) })),
      workedExample: worked ? { content: privateTask.workedExample ?? repository.invariant(), usedAt: repository.storedTime(worked.created_at) } : null };
  }
  const support = await repository.readSupport(tx, enrollment);
  const { availability: freshAssessment } = await loadFreshAssessmentChoice(tx, enrollment, program);
  const relevantOutcomes = new Set([...route.pendingOutcomeIds, ...(currentLesson?.outcomeIds ?? []), ...(currentTask?.outcomeIds ?? [])]);
  const outline: LearningContext["outline"] = lessonIds.map((lessonId) => {
    const lesson = program.lessons.find(({ id }) => id === lessonId) ?? repository.invariant();
    return { lessonId, title: lesson.title, outcomeIds: lesson.outcomeIds,
      availability: lessonId === enrollment.currentLessonId ? "current" : traversed.has(lessonId) ? "completed" : "upcoming",
      positions: normal.next.filter((position) => position.lessonId === lessonId).map(({ taskId }) => {
        const task = taskId === null ? null : program.tasks.find(({ task }) => task.id === taskId)?.task ?? repository.invariant();
        return { taskId, taskVersion: task?.taskVersion ?? null, instruction: task?.instruction ?? null, revisitable: traversed.has(lessonId) };
      }) };
  });
  const makeContext = (): LearningContext => ({ enrollmentId: enrollment.id, routeRevision: route.revision,
    course: { id: enrollment.courseId, versionId: program.version.id, versionNumber: program.version.number, title: program.version.title, contentLanguage: program.version.contentLanguage },
    outcomes: program.version.outcomes.filter(({ id }) => relevantOutcomes.has(id)).map(({ id, title }) => ({ id, title })), outline,
    outlineNextCursor: index + outline.length < program.version.lessonIds.length ? Buffer.from(JSON.stringify({ versionId: program.version.id, routeRevision: route.revision, index: index + outline.length })).toString("base64url") : null,
    citations: sources.map((row) => ({ id: row.id, title: row.title, url: row.final_url, retrievedAt: repository.storedTime(row.retrieved_at) })), assistance, freshAssessment,
    revisitBlockedReason: enrollment.status === "archived" ? "archived" : support ? "support_active" : route.next.some(({ reasonCode }) => reasonCode === "scheduled_review") ? "review_active" : null });
  let result = makeContext();
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 2 * 1024 * 1024 && outline.length > 1) { outline.pop(); result = makeContext(); }
  return LearningContextSchema.parse(result);
}
