import { z } from "zod";
import { pageSchema, ContentLanguageSchema, IdSchema, IsoDateTimeSchema } from "./common";
import {
  AccessibleCourseDetailSchema, CourseCoverSchema, CourseSchema, CourseSummarySchema,
} from "./course";
import { EnrollmentReceiptSchema, EnrollmentSchema } from "./learning";

export const CatalogQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  contentLanguage: ContentLanguageSchema.optional(),
  cursor: z.string().max(2_000).optional(),
  limit: z.number().int().min(1).max(60).optional(),
}).strict();

export const LibraryViewSchema = z.enum(["all", "courses", "in_progress"]);
export const LibraryQuerySchema = CatalogQuerySchema.extend({ view: LibraryViewSchema.optional() }).strict();

export const CourseVersionIdentitySchema = z.object({ id: IdSchema, number: z.number().int().positive() }).strict();
export const OwnedVersionSummarySchema = CourseVersionIdentitySchema.extend({
  state: z.enum(["building", "validating", "ready", "failed"]),
}).strict();

export const OwnedCourseProjectionSchema = CourseSchema.pick({
  id: true, slug: true, title: true, summary: true, contentLanguage: true, visibility: true,
  currentReadyVersionId: true, publishedVersionId: true, updatedAt: true, revision: true,
}).extend({
  cover: CourseCoverSchema.nullable(),
  latestVersion: OwnedVersionSummarySchema.nullable(),
  conversationId: IdSchema.nullable(),
}).strict();

export const EnrolledCourseProjectionSchema = z.object({
  course: CourseSummarySchema,
  version: CourseVersionIdentitySchema,
  enrollment: EnrollmentSchema,
}).strict();

export const LibraryCourseItemSchema = z.object({
  courseId: IdSchema,
  owned: OwnedCourseProjectionSchema.nullable(),
  enrollments: z.array(EnrolledCourseProjectionSchema),
}).strict().superRefine((value, context) => {
  if (value.owned === null && value.enrollments.length === 0) {
    context.addIssue({ code: "custom", message: "A library group needs an owned or enrolled course" });
  }
  if (value.owned && value.owned.id !== value.courseId) {
    context.addIssue({ code: "custom", path: ["owned", "id"], message: "Owned course does not match its group" });
  }
  if (value.enrollments.some((item) => item.course.id !== value.courseId || item.enrollment.courseId !== value.courseId
    || item.enrollment.courseVersionId !== item.version.id)) {
    context.addIssue({ code: "custom", path: ["enrollments"], message: "Enrolled course does not match its group" });
  }
});

export const CourseDetailResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), detail: AccessibleCourseDetailSchema }).strict(),
  z.object({ kind: z.literal("owned_unready"), course: OwnedCourseProjectionSchema }).strict(),
]);

export const EnrollmentInputSchema = z.object({
  courseVersionId: IdSchema,
  shareToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict();

export const CreateShareInputSchema = z.object({
  courseVersionId: IdSchema,
  expectedCourseRevision: z.number().int().min(1),
}).strict();

export const ShareSummarySchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  courseVersionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
}).strict();

export const ShareListSchema = z.object({
  courseRevision: z.number().int().min(1),
  items: z.array(ShareSummarySchema),
}).strict();

export const ShareCreatedSchema = z.object({
  shareId: IdSchema,
  shareUrl: z.string().regex(/^\/s\/[A-Za-z0-9_-]{43}$/),
  courseRevision: z.number().int().min(1),
}).strict();

export const CourseSummaryPageSchema = pageSchema(CourseSummarySchema);
export const LibraryCoursePageSchema = pageSchema(LibraryCourseItemSchema);

export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
export type LibraryView = z.infer<typeof LibraryViewSchema>;
export type LibraryQuery = z.infer<typeof LibraryQuerySchema>;
export type CourseVersionIdentity = z.infer<typeof CourseVersionIdentitySchema>;
export type OwnedCourseProjection = z.infer<typeof OwnedCourseProjectionSchema>;
export type EnrolledCourseProjection = z.infer<typeof EnrolledCourseProjectionSchema>;
export type LibraryCourseItem = z.infer<typeof LibraryCourseItemSchema>;
export type CourseDetailResult = z.infer<typeof CourseDetailResultSchema>;
export type EnrollmentInput = z.infer<typeof EnrollmentInputSchema>;
export type EnrollmentReceipt = z.infer<typeof EnrollmentReceiptSchema>;
export type CreateShareInput = z.infer<typeof CreateShareInputSchema>;
export type ShareSummary = z.infer<typeof ShareSummarySchema>;
export type ShareList = z.infer<typeof ShareListSchema>;
export type ShareCreated = z.infer<typeof ShareCreatedSchema>;
