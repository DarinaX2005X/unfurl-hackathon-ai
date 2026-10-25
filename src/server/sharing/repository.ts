import "server-only";
import { z } from "zod";
import { IdSchema } from "../../domain/common";
import { ShareListSchema, type ShareList } from "../../domain/catalog";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";
import { lockOwnedCourse } from "../catalog/access";
import { VERSION_SELECT, enrollmentForVersion } from "../catalog/repository";
import { accessibleFromVersion, CourseProjectionRowSchema } from "../catalog/projections";
import { hashShareToken } from "./crypto";

const time = z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString());
const ShareRowSchema = z.object({
  id: IdSchema, course_id: IdSchema, course_version_id: IdSchema, created_at: time, revoked_at: time.nullable(),
}).passthrough();

export async function listShares(tx: DbTransaction, actor: Actor, courseId: string): Promise<ShareList> {
  const course = await lockOwnedCourse(tx, actor, courseId);
  const result = await tx.query(
    `SELECT id, course_id, course_version_id, created_at, revoked_at FROM unfurl.share_grants
     WHERE course_id = $1 ORDER BY created_at DESC, id DESC`, [course.id],
  );
  return ShareListSchema.parse({ courseRevision: course.revision, items: result.rows.map((value) => {
    const row = ShareRowSchema.parse(value);
    return { id: row.id, courseId: row.course_id, courseVersionId: row.course_version_id,
      createdAt: row.created_at, revokedAt: row.revoked_at };
  }) });
}

export async function requireReadyVersion(tx: DbTransaction, courseId: string, versionId: string): Promise<void> {
  const result = await tx.query(
    `SELECT v.id FROM unfurl.course_versions v
     JOIN unfurl.version_validation_receipts receipt
       ON receipt.id = v.validation_receipt_id AND receipt.course_version_id = v.id AND receipt.verdict = 'passed'
     JOIN unfurl.generation_runs run
       ON run.id = v.source_run_id AND run.course_id = v.course_id AND run.output_version_id = v.id AND run.status = 'succeeded'
     WHERE v.id = $1 AND v.course_id = $2 AND v.state = 'ready' AND v.cover IS NOT NULL`, [versionId, courseId],
  );
  if (!result.rows[0]) throw new ServiceFault(404, "not_found", "catalog.notFound");
}

export async function requireActiveGrant(tx: DbTransaction, actor: Actor, courseId: string, grantId: string, lock = true) {
  const result = await tx.query<{ id: string; course_version_id: string; token_key_version: string; revoked_at: Date | string | null }>(
    `SELECT id, course_version_id, token_key_version, revoked_at FROM unfurl.share_grants
     WHERE id = $1 AND course_id = $2 AND created_by = $3 ${lock ? "FOR UPDATE" : ""}`,
    [grantId, courseId, actor.id],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at !== null) throw new ServiceFault(409, "revision_conflict", "sharing.revoked");
  return row;
}

/** The caller must already hold the course row lock. */
export async function revokeActiveShareGrants(tx: DbTransaction, courseId: string): Promise<number> {
  const locked = await tx.query<{ id: string }>(
    "SELECT id FROM unfurl.share_grants WHERE course_id = $1 AND revoked_at IS NULL ORDER BY id FOR UPDATE", [courseId],
  );
  if (!locked.rows.length) return 0;
  const result = await tx.query("UPDATE unfurl.share_grants SET revoked_at = now() WHERE course_id = $1 AND revoked_at IS NULL", [courseId]);
  return result.rowCount ?? 0;
}

export async function resolveShare(tx: DbTransaction, actor: Actor | null, token: string) {
  let hash: string;
  try { hash = hashShareToken(token); } catch { throw new ServiceFault(404, "not_found", "catalog.notFound"); }
  const result = await tx.query(
    `SELECT ${VERSION_SELECT}
     FROM unfurl.share_grants grant
     JOIN unfurl.courses c ON c.id = grant.course_id
     JOIN unfurl.course_versions v ON v.id = grant.course_version_id AND v.course_id = c.id
     WHERE grant.token_hash = $1 AND grant.revoked_at IS NULL AND c.visibility IN ('unlisted', 'public')
       AND v.state = 'ready' AND v.cover IS NOT NULL`, [hash],
  );
  const parsed = CourseProjectionRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) throw new ServiceFault(404, "not_found", "catalog.notFound");
  const enrollment = await enrollmentForVersion(tx, actor, parsed.data.course_id, parsed.data.id);
  const access = actor?.id === parsed.data.owner_id ? "owner" : enrollment ? "enrolled" : "share";
  return accessibleFromVersion(parsed.data, access, enrollment?.id ?? null);
}
