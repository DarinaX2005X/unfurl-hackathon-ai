import "server-only";
import { z } from "zod";
import { EnrollmentSchema, LessonSchema, type Enrollment, type Lesson } from "../../domain/learning";
import { TaskAssessmentSchema, TaskPublicSchema, type TaskAssessment, type TaskPublic } from "../../domain/mechanics";
import type { CourseVersion } from "../../domain/course";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";
import { courseVersionFromRow } from "../catalog/projections";
import { hashShareToken } from "../sharing/crypto";

const time = z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString());
const EnrollmentRowSchema = z.object({
  id: z.string(), learner_id: z.string(), course_id: z.string(), course_version_id: z.string(), status: z.string(),
  route_revision: z.number(), current_lesson_id: z.string().nullable(), current_task_id: z.string().nullable(),
  created_at: time, last_studied_at: time.nullable(),
}).passthrough();

export function enrollmentFromRow(value: unknown): Enrollment {
  const row = EnrollmentRowSchema.parse(value);
  return EnrollmentSchema.parse({
    id: row.id, learnerId: row.learner_id, courseId: row.course_id, courseVersionId: row.course_version_id,
    status: row.status, routeRevision: row.route_revision, currentLessonId: row.current_lesson_id,
    currentTaskId: row.current_task_id, createdAt: row.created_at, lastStudiedAt: row.last_studied_at,
  });
}

export async function findEnrollment(tx: DbTransaction, actor: Actor, courseId: string, versionId: string, lock = false) {
  const result = await tx.query(
    `SELECT * FROM unfurl.enrollments WHERE learner_id = $1 AND course_id = $2 AND course_version_id = $3 ${lock ? "FOR UPDATE" : ""}`,
    [actor.id, courseId, versionId],
  );
  return result.rows[0] ? enrollmentFromRow(result.rows[0]) : null;
}

export async function reactivateEnrollment(tx: DbTransaction, enrollment: Enrollment): Promise<Enrollment> {
  if (enrollment.status !== "archived") return enrollment;
  const result = await tx.query("UPDATE unfurl.enrollments SET status = 'active' WHERE id = $1 RETURNING *", [enrollment.id]);
  return enrollmentFromRow(result.rows[0]);
}

export async function requireShareAccess(tx: DbTransaction, courseId: string, versionId: string, token: string): Promise<void> {
  let hash: string;
  try { hash = hashShareToken(token); } catch { throw new ServiceFault(404, "not_found", "catalog.notFound"); }
  const result = await tx.query(
    `SELECT grant.id FROM unfurl.share_grants grant JOIN unfurl.courses c ON c.id = grant.course_id
     WHERE grant.token_hash = $1 AND grant.course_id = $2 AND grant.course_version_id = $3
       AND grant.revoked_at IS NULL AND c.visibility IN ('unlisted', 'public') FOR UPDATE OF grant`,
    [hash, courseId, versionId],
  );
  if (!result.rows[0]) throw new ServiceFault(404, "not_found", "catalog.notFound");
}

export async function loadLearningMaterial(tx: DbTransaction, courseId: string, versionId: string): Promise<{
  version: CourseVersion; lessons: Lesson[]; tasks: Array<{ task: TaskPublic; assessment: TaskAssessment }>;
}> {
  const versionResult = await tx.query(
    `SELECT v.id, v.course_id, v.number, v.approval_id, v.source_run_id, v.content_digest, v.state,
       v.title, v.summary, v.content_language, v.assumed_knowledge, v.outcomes, v.modules, v.lesson_ids,
       v.validation_receipt_id, v.cover, v.created_at, v.ready_at
     FROM unfurl.course_versions v
     JOIN unfurl.version_validation_receipts receipt
       ON receipt.id = v.validation_receipt_id AND receipt.course_version_id = v.id AND receipt.verdict = 'passed'
     JOIN unfurl.generation_runs run
       ON run.id = v.source_run_id AND run.course_id = v.course_id AND run.output_version_id = v.id AND run.status = 'succeeded'
     WHERE v.id = $1 AND v.course_id = $2 AND v.state = 'ready' AND v.cover IS NOT NULL`, [versionId, courseId],
  );
  if (!versionResult.rows[0]) throw new ServiceFault(404, "not_found", "catalog.notFound");
  const version = courseVersionFromRow(versionResult.rows[0]);
  const lessonResult = await tx.query(
    "SELECT id, course_version_id, module_id, title, outcome_ids, blocks, task_ids FROM unfurl.lessons WHERE course_version_id = $1 AND id = ANY($2::uuid[])",
    [version.id, version.lessonIds],
  );
  const lessons = lessonResult.rows.map((row) => LessonSchema.parse({
    id: row.id, courseVersionId: row.course_version_id, moduleId: row.module_id, title: row.title,
    outcomeIds: row.outcome_ids, blocks: row.blocks, taskIds: row.task_ids,
  }));
  const taskIds = lessons.flatMap((lesson) => lesson.taskIds);
  const taskResult = await tx.query(
    `SELECT p.id, p.task_version, p.mechanic_id, p.mechanic_version, p.outcome_ids, p.instruction,
       p.content_language, p.config, p.available_hints, p.response_schema_version, private.assessment
     FROM unfurl.tasks_public p JOIN unfurl.tasks_private private
       ON private.task_id = p.id AND private.task_version = p.task_version
     WHERE p.course_version_id = $1 AND p.id = ANY($2::uuid[])`, [version.id, taskIds],
  );
  const tasks = taskResult.rows.map((row) => ({
    task: TaskPublicSchema.parse({ id: row.id, taskVersion: row.task_version, mechanicId: row.mechanic_id,
      mechanicVersion: row.mechanic_version, outcomeIds: row.outcome_ids, instruction: row.instruction,
      contentLanguage: row.content_language, config: row.config, availableHints: row.available_hints,
      responseSchemaVersion: row.response_schema_version }),
    assessment: TaskAssessmentSchema.parse(row.assessment),
  }));
  return { version, lessons, tasks };
}

export async function insertEnrollment(tx: DbTransaction, input: {
  id: string; actor: Actor; courseId: string; versionId: string; currentLessonId: string; currentTaskId: string | null;
}): Promise<Enrollment> {
  const result = await tx.query(
    `INSERT INTO unfurl.enrollments
      (id, learner_id, course_id, course_version_id, status, route_revision, current_lesson_id, current_task_id)
     VALUES ($1, $2, $3, $4, 'active', 1, $5, $6) RETURNING *`,
    [input.id, input.actor.id, input.courseId, input.versionId, input.currentLessonId, input.currentTaskId],
  );
  return enrollmentFromRow(result.rows[0]);
}
