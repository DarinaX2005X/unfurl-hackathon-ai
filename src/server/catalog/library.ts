import "server-only";
import { z } from "zod";
import { EnrollmentSchema } from "../../domain/learning";
import {
  LibraryCourseItemSchema, LibraryQuerySchema, type EnrolledCourseProjection, type LibraryCourseItem, type LibraryQuery,
} from "../../domain/catalog";
import type { Actor } from "../auth/actor";
import type { DbTransaction } from "../db";
import { cursorFilters, decodeCursor, encodeCursor } from "./cursor";
import { ownedFromRow, summaryFromVersion, courseVersionFromRow } from "./projections";

const FacetRowSchema = z.object({
  course_id: z.string(), kind: z.enum(["owned", "enrolled"]),
  group_sort_at: z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString()),
  payload: z.record(z.string(), z.unknown()),
}).strict();

function enrollmentFromRow(value: unknown) {
  const row = z.object({
    id: z.string(), learner_id: z.string(), course_id: z.string(), course_version_id: z.string(), status: z.string(),
    route_revision: z.number(), current_lesson_id: z.string().nullable(), current_task_id: z.string().nullable(),
    created_at: z.union([z.date(), z.string()]), last_studied_at: z.union([z.date(), z.string()]).nullable(),
  }).passthrough().parse(value);
  return EnrollmentSchema.parse({
    id: row.id, learnerId: row.learner_id, courseId: row.course_id, courseVersionId: row.course_version_id,
    status: row.status, routeRevision: row.route_revision, currentLessonId: row.current_lesson_id,
    currentTaskId: row.current_task_id, createdAt: new Date(row.created_at).toISOString(),
    lastStudiedAt: row.last_studied_at === null ? null : new Date(row.last_studied_at).toISOString(),
  });
}

function enrolledFromPayload(payload: Record<string, unknown>): EnrolledCourseProjection {
  const version = courseVersionFromRow(payload.version);
  const enrollment = enrollmentFromRow(payload.enrollment);
  return { course: summaryFromVersion(payload.version), version: { id: version.id, number: version.number }, enrollment };
}

export async function listLibrary(tx: DbTransaction, actor: Actor, query: LibraryQuery) {
  const parsed = LibraryQuerySchema.parse(query);
  const limit = parsed.limit ?? 24;
  const view = parsed.view ?? "all";
  const q = parsed.q?.trim() || null;
  const language = parsed.contentLanguage ?? null;
  const filters = cursorFilters({ view, q: q ?? "", contentLanguage: language ?? "" });
  const cursor = decodeCursor(parsed.cursor, "library-v1", filters);
  const result = await tx.query(
    `WITH owned_facets AS (
       SELECT c.id AS course_id, 'owned'::text AS kind, c.updated_at AS sort_at,
         jsonb_build_object(
           'id', c.id, 'slug', c.slug, 'title', c.title, 'summary', c.summary, 'content_language', c.content_language,
           'visibility', c.visibility, 'current_ready_version_id', c.current_ready_version_id,
           'published_version_id', c.published_version_id, 'cover', c.cover, 'updated_at', c.updated_at,
           'revision', c.revision, 'conversation_id', relation.conversation_id,
           'latest_version_id', latest.id, 'latest_version_number', latest.number, 'latest_version_state', latest.state
         ) AS payload
       FROM unfurl.courses c
       LEFT JOIN LATERAL (SELECT v.id, v.number, v.state FROM unfurl.course_versions v
         WHERE v.course_id = c.id ORDER BY v.number DESC LIMIT 1) latest ON true
       LEFT JOIN LATERAL (SELECT a.conversation_id FROM unfurl.conversation_artifacts a
         JOIN unfurl.conversations conversation ON conversation.id = a.conversation_id
         WHERE a.course_id = c.id AND conversation.owner_id = c.owner_id AND conversation.deleted_at IS NULL
         ORDER BY a.created_at DESC, a.conversation_id DESC LIMIT 1) relation ON true
       WHERE c.owner_id = $1 AND $2::text IN ('all', 'courses')
         AND ($3::text IS NULL OR position(lower($3) in lower(c.title || ' ' || c.summary)) > 0)
         AND ($4::text IS NULL OR lower(c.content_language) = lower($4))
     ), enrolled_facets AS (
       SELECT c.id AS course_id, 'enrolled'::text AS kind, COALESCE(e.last_studied_at, e.created_at) AS sort_at,
         jsonb_build_object(
           'version', jsonb_build_object(
             'id', v.id, 'course_id', v.course_id, 'number', v.number, 'approval_id', v.approval_id,
             'source_run_id', v.source_run_id, 'content_digest', v.content_digest, 'state', v.state,
             'title', v.title, 'summary', v.summary, 'content_language', v.content_language,
             'assumed_knowledge', v.assumed_knowledge, 'outcomes', v.outcomes, 'modules', v.modules,
             'lesson_ids', v.lesson_ids, 'validation_receipt_id', v.validation_receipt_id, 'cover', v.cover,
             'created_at', v.created_at, 'ready_at', v.ready_at, 'slug', c.slug, 'visibility', c.visibility, 'owner_id', c.owner_id
           ),
           'enrollment', to_jsonb(e)
         ) AS payload
       FROM unfurl.enrollments e
       JOIN unfurl.courses c ON c.id = e.course_id
       JOIN unfurl.course_versions v ON v.id = e.course_version_id AND v.course_id = c.id
       WHERE e.learner_id = $1 AND $2::text <> 'courses'
         AND ($2::text <> 'in_progress' OR e.status = 'active')
         AND v.state = 'ready' AND v.cover IS NOT NULL
         AND ($3::text IS NULL OR position(lower($3) in lower(v.title || ' ' || v.summary)) > 0)
         AND ($4::text IS NULL OR lower(v.content_language) = lower($4))
     ), facets AS (SELECT * FROM owned_facets UNION ALL SELECT * FROM enrolled_facets),
     groups AS (
       SELECT course_id, max(sort_at) AS group_sort_at FROM facets GROUP BY course_id
       HAVING ($5::timestamptz IS NULL OR (max(sort_at), course_id) < ($5::timestamptz, $6::uuid))
       ORDER BY group_sort_at DESC, course_id DESC LIMIT $7
     )
     SELECT f.course_id, f.kind, g.group_sort_at, f.payload FROM groups g JOIN facets f USING (course_id)
     ORDER BY g.group_sort_at DESC, f.course_id DESC, f.kind, f.sort_at DESC`,
    [actor.id, view, q, language, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const groups = new Map<string, { sortAt: string; item: LibraryCourseItem }>();
  for (const raw of result.rows) {
    const row = FacetRowSchema.parse(raw);
    const group = groups.get(row.course_id) ?? { sortAt: row.group_sort_at,
      item: { courseId: row.course_id, owned: null, enrollments: [] } };
    if (row.kind === "owned") group.item.owned = ownedFromRow(row.payload);
    else group.item.enrollments.push(enrolledFromPayload(row.payload));
    groups.set(row.course_id, group);
  }
  const ordered = [...groups.values()];
  const visible = ordered.slice(0, limit);
  const tail = visible.at(-1);
  return {
    items: visible.map(({ item }) => LibraryCourseItemSchema.parse(item)),
    nextCursor: ordered.length > limit && tail
      ? encodeCursor({ kind: "library-v1", sortAt: tail.sortAt, id: tail.item.courseId, filters }) : null,
  };
}
