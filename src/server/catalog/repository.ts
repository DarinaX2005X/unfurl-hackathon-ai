import "server-only";
import { IdSchema } from "../../domain/common";
import { CatalogQuerySchema, type CatalogQuery, type CourseDetailResult } from "../../domain/catalog";
import type { Actor } from "../auth/actor";
import { ServiceFault } from "../auth/errors";
import type { DbTransaction } from "../db";
import { cursorFilters, decodeCursor, encodeCursor } from "./cursor";
import {
  accessibleFromVersion, CourseProjectionRowSchema, courseVersionFromRow, ownedFromRow, summaryFromVersion,
} from "./projections";

export const VERSION_SELECT = `v.id, v.course_id, v.number, v.approval_id, v.source_run_id, v.content_digest, v.state,
  v.title, v.summary, v.content_language, v.assumed_knowledge, v.outcomes, v.modules, v.lesson_ids,
  v.validation_receipt_id, v.cover, v.created_at, v.ready_at, v.release_metadata, c.slug, c.visibility, c.owner_id`;
export const OWNED_SELECT = `c.id, c.slug, c.title, c.summary, c.content_language, c.visibility, c.current_ready_version_id,
  c.published_version_id, c.cover, c.updated_at, c.revision, relation.conversation_id,
  latest.id AS latest_version_id, latest.number AS latest_version_number, latest.state AS latest_version_state`;
export const OWNED_JOINS = `LEFT JOIN LATERAL (
    SELECT v.id, v.number, v.state FROM unfurl.course_versions v WHERE v.course_id = c.id ORDER BY v.number DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT a.conversation_id FROM unfurl.conversation_artifacts a
    JOIN unfurl.conversations conversation ON conversation.id = a.conversation_id
    WHERE a.course_id = c.id AND conversation.owner_id = c.owner_id AND conversation.deleted_at IS NULL
    ORDER BY a.created_at DESC, a.conversation_id DESC LIMIT 1
  ) relation ON true`;

function input(query: CatalogQuery): CatalogQuery & { limit: number } {
  const parsed = CatalogQuerySchema.parse(query);
  return { ...parsed, limit: parsed.limit ?? 24 };
}
function notFound(): never { throw new ServiceFault(404, "not_found", "catalog.notFound"); }

export async function listPublic(tx: DbTransaction, query: CatalogQuery) {
  const value = input(query);
  const q = value.q?.trim() || null;
  const language = value.contentLanguage ?? null;
  const filters = cursorFilters({ q: q ?? "", contentLanguage: language ?? "" });
  const cursor = decodeCursor(value.cursor, "catalog-v1", filters);
  const result = await tx.query(
    `SELECT ${VERSION_SELECT}
     FROM unfurl.courses c JOIN unfurl.course_versions v ON v.id = c.published_version_id AND v.course_id = c.id
     WHERE c.visibility = 'public' AND v.state = 'ready' AND v.cover IS NOT NULL
       AND ($1::text IS NULL OR position(lower($1) in lower(v.title || ' ' || v.summary)) > 0)
       AND ($2::text IS NULL OR lower(v.content_language) = lower($2))
       AND ($3::timestamptz IS NULL OR (v.ready_at, c.id) < ($3::timestamptz, $4::uuid))
     ORDER BY v.ready_at DESC, c.id DESC LIMIT $5`,
    [q, language, cursor?.sortAt ?? null, cursor?.id ?? null, value.limit + 1],
  );
  const rows = result.rows.map((row) => ({ row, version: courseVersionFromRow(row) }));
  const items = rows.slice(0, value.limit).map(({ row }) => summaryFromVersion(row));
  const tail = rows[value.limit - 1];
  return { items, nextCursor: rows.length > value.limit && tail
    ? encodeCursor({ kind: "catalog-v1", sortAt: tail.version.readyAt!, id: tail.version.courseId, filters }) : null };
}

async function ownedBy(tx: DbTransaction, actor: Actor, field: "id" | "slug", value: string) {
  const result = await tx.query(
    `SELECT ${OWNED_SELECT} FROM unfurl.courses c ${OWNED_JOINS}
     WHERE c.${field} = $1 AND c.owner_id = $2`, [value, actor.id],
  );
  return result.rows[0] ? ownedFromRow(result.rows[0]) : null;
}

export async function versionById(tx: DbTransaction, courseId: string, versionId: string) {
  const result = await tx.query(
    `SELECT ${VERSION_SELECT} FROM unfurl.courses c JOIN unfurl.course_versions v ON v.course_id = c.id
     WHERE c.id = $1 AND v.id = $2`, [courseId, versionId],
  );
  return result.rows[0] ?? null;
}

export async function enrollmentForVersion(tx: DbTransaction, actor: Actor | null, courseId: string, versionId?: string) {
  if (!actor) return null;
  const result = await tx.query<{ id: string; course_version_id: string }>(
    `SELECT id, course_version_id FROM unfurl.enrollments
     WHERE learner_id = $1 AND course_id = $2 ${versionId ? "AND course_version_id = $3" : ""}
     ORDER BY COALESCE(last_studied_at, created_at) DESC, id DESC LIMIT 1`,
    versionId ? [actor.id, courseId, versionId] : [actor.id, courseId],
  );
  return result.rows[0] ?? null;
}

async function readyResult(tx: DbTransaction, row: unknown, actor: Actor | null, forceAccess?: "share"): Promise<CourseDetailResult> {
  const parsed = CourseProjectionRowSchema.parse(row);
  const enrollment = await enrollmentForVersion(tx, actor, parsed.course_id, parsed.id);
  const access = forceAccess ?? (actor?.id === parsed.owner_id ? "owner" : enrollment ? "enrolled" : parsed.visibility === "public" ? "public" : null);
  if (!access) return notFound();
  return { kind: "ready", detail: accessibleFromVersion(parsed, access, enrollment?.id ?? null) };
}

export async function getBySlug(tx: DbTransaction, actor: Actor | null, slug: string): Promise<CourseDetailResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160) throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
  const courseResult = await tx.query<{ id: string; owner_id: string; published_version_id: string | null }>(
    "SELECT id, owner_id, published_version_id FROM unfurl.courses WHERE slug = $1", [slug],
  );
  const course = courseResult.rows[0];
  if (!course) return notFound();
  if (course.published_version_id) {
    const row = await versionById(tx, course.id, course.published_version_id);
    if (!row) return notFound();
    return readyResult(tx, row, actor);
  }
  const enrollment = await enrollmentForVersion(tx, actor, course.id);
  if (enrollment) {
    const row = await versionById(tx, course.id, enrollment.course_version_id);
    if (!row) return notFound();
    return readyResult(tx, row, actor);
  }
  if (actor?.id !== course.owner_id) return notFound();
  const owned = await ownedBy(tx, actor, "slug", slug);
  if (!owned) return notFound();
  if (owned.latestVersion?.state === "ready") {
    const row = await versionById(tx, course.id, owned.latestVersion.id);
    if (!row) return notFound();
    return readyResult(tx, row, actor);
  }
  return { kind: "owned_unready", course: owned };
}

export async function getCourse(tx: DbTransaction, actor: Actor | null, courseId: string, versionId?: string): Promise<CourseDetailResult> {
  const id = IdSchema.safeParse(courseId);
  const version = versionId === undefined ? null : IdSchema.safeParse(versionId);
  if (!id.success || (version && !version.success)) throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
  const courseResult = await tx.query<{ id: string; owner_id: string; published_version_id: string | null }>(
    "SELECT id, owner_id, published_version_id FROM unfurl.courses WHERE id = $1", [id.data],
  );
  const course = courseResult.rows[0];
  if (!course) return notFound();
  const owned = actor?.id === course.owner_id ? await ownedBy(tx, actor, "id", id.data) : null;
  let selected = version?.success ? version.data : course.published_version_id;
  if (!selected) selected = (await enrollmentForVersion(tx, actor, id.data))?.course_version_id ?? owned?.latestVersion?.id ?? null;
  if (!selected) return owned ? { kind: "owned_unready", course: owned } : notFound();
  const row = await versionById(tx, id.data, selected);
  if (!row) return notFound();
  const parsed = courseVersionFromRow(row);
  if (parsed.state !== "ready") return owned ? { kind: "owned_unready", course: owned } : notFound();
  if (!owned && !(await enrollmentForVersion(tx, actor, id.data, selected)) && course.published_version_id !== selected) return notFound();
  return readyResult(tx, row, actor);
}

export const ownedProjectionById = (tx: DbTransaction, actor: Actor, id: string) => ownedBy(tx, actor, "id", id);
