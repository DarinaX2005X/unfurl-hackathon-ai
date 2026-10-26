import "server-only";
import { z } from "zod";
import {
  CourseDetailPublicSchema, CourseSummarySchema, CourseVersionSchema,
  type AccessibleCourseDetail, type CourseDetailPublic, type CourseSummary, type CourseVersion,
} from "../../domain/course";
import { OwnedCourseProjectionSchema, type OwnedCourseProjection } from "../../domain/catalog";
import { previewFromVersion } from "../course-materialization/preview-metadata";

const timestamp = z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString());

export const VersionRowSchema = z.object({
  id: z.string(), course_id: z.string(), number: z.number(), approval_id: z.string(), source_run_id: z.string(),
  content_digest: z.string(), state: z.string(), title: z.string(), summary: z.string(), content_language: z.string(),
  assumed_knowledge: z.unknown(), outcomes: z.unknown(), modules: z.unknown(), lesson_ids: z.array(z.string()),
  validation_receipt_id: z.string().nullable(), cover: z.unknown().nullable(), created_at: timestamp, ready_at: timestamp.nullable(),
  release_metadata: z.unknown().optional(),
}).passthrough();

export const CourseProjectionRowSchema = VersionRowSchema.extend({
  slug: z.string(), visibility: z.string(), owner_id: z.string(),
}).passthrough();

export function courseVersionFromRow(value: unknown): CourseVersion {
  const row = VersionRowSchema.parse(value);
  return CourseVersionSchema.parse({
    id: row.id, courseId: row.course_id, number: row.number, approvalId: row.approval_id, sourceRunId: row.source_run_id,
    contentDigest: row.content_digest, state: row.state, title: row.title, summary: row.summary,
    contentLanguage: row.content_language, assumedKnowledge: row.assumed_knowledge, outcomes: row.outcomes,
    modules: row.modules, lessonIds: row.lesson_ids, validationReceiptId: row.validation_receipt_id,
    cover: row.cover, createdAt: row.created_at, readyAt: row.ready_at,
  });
}

export function summaryFromVersion(value: unknown): CourseSummary {
  const row = CourseProjectionRowSchema.parse(value);
  const version = courseVersionFromRow(row);
  if (version.state !== "ready" || version.cover === null) throw new Error("Public projection requires a ready covered version");
  const preview = previewFromVersion(row.release_metadata, version);
  return CourseSummarySchema.parse({
    id: version.courseId, slug: row.slug, title: version.title, summary: version.summary,
    contentLanguage: version.contentLanguage, visibility: row.visibility,
    moduleCount: version.modules.length, lessonCount: version.lessonIds.length,
    estimatedStudyMinutes: version.modules.reduce((total, module) => total + module.estimatedStudyMinutes, 0), cover: version.cover,
    ...(preview ? { publisher: preview.publisher } : {}),
  });
}

export function detailFromVersion(value: unknown): CourseDetailPublic {
  const version = courseVersionFromRow(value);
  const preview = previewFromVersion(VersionRowSchema.parse(value).release_metadata, version);
  return CourseDetailPublicSchema.parse({ ...summaryFromVersion(value), assumedKnowledge: version.assumedKnowledge,
    outcomes: version.outcomes, modules: version.modules, ...(preview ? { release: preview.presentation } : {}) });
}

export function accessibleFromVersion(value: unknown, access: AccessibleCourseDetail["access"], enrollmentId: string | null): AccessibleCourseDetail {
  const version = courseVersionFromRow(value);
  return { course: detailFromVersion(value), version: { id: version.id, number: version.number }, access, enrollmentId };
}

export const OwnedRowSchema = z.object({
  id: z.string(), slug: z.string(), title: z.string(), summary: z.string(), content_language: z.string(),
  visibility: z.string(), current_ready_version_id: z.string().nullable(), published_version_id: z.string().nullable(),
  cover: z.unknown().nullable(), updated_at: timestamp, revision: z.number(), conversation_id: z.string().nullable(),
  latest_version_id: z.string().nullable(), latest_version_number: z.number().nullable(), latest_version_state: z.string().nullable(),
}).passthrough();

export function ownedFromRow(value: unknown): OwnedCourseProjection {
  const row = OwnedRowSchema.parse(value);
  return OwnedCourseProjectionSchema.parse({
    id: row.id, slug: row.slug, title: row.title, summary: row.summary, contentLanguage: row.content_language,
    visibility: row.visibility, currentReadyVersionId: row.current_ready_version_id, publishedVersionId: row.published_version_id,
    cover: row.cover, updatedAt: row.updated_at, revision: row.revision, conversationId: row.conversation_id,
    latestVersion: row.latest_version_id === null ? null : { id: row.latest_version_id, number: row.latest_version_number, state: row.latest_version_state },
  });
}
