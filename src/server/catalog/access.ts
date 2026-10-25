import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";

const CourseLockRowSchema = z.object({
  id: IdSchema,
  owner_id: IdSchema,
  visibility: z.enum(["private", "unlisted", "public"]),
  revision: z.number().int().positive(),
  current_ready_version_id: IdSchema.nullable(),
  published_version_id: IdSchema.nullable(),
}).strict();
export type CourseLock = z.infer<typeof CourseLockRowSchema>;

export async function lockCourse(tx: DbTransaction, courseId: string): Promise<CourseLock> {
  const id = IdSchema.safeParse(courseId);
  if (!id.success) throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
  const result = await tx.query(
    `SELECT id, owner_id, visibility, revision, current_ready_version_id, published_version_id
     FROM unfurl.courses WHERE id = $1 FOR UPDATE`, [id.data],
  );
  const row = CourseLockRowSchema.safeParse(result.rows[0]);
  if (!row.success) throw new ServiceFault(404, "not_found", "catalog.notFound");
  return row.data;
}

export async function lockOwnedCourse(tx: DbTransaction, actor: Actor, courseId: string): Promise<CourseLock> {
  const course = await lockCourse(tx, courseId);
  if (course.owner_id !== actor.id) throw new ServiceFault(404, "not_found", "catalog.notFound");
  return course;
}
