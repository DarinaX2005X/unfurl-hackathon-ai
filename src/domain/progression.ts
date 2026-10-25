import { z } from "zod";
import { IdSchema, RevisionSchema, VisibilitySchema } from "./common";
import { AccountProgressSchema } from "./learning";

export const CourseVisibilityInputSchema = z.object({
  expectedRevision: RevisionSchema,
  visibility: VisibilitySchema,
  courseVersionId: IdSchema,
}).strict();

export const CourseVisibilityReceiptSchema = z.object({
  courseId: IdSchema,
  visibility: VisibilitySchema,
  publishedVersionId: IdSchema.nullable(),
  revision: RevisionSchema,
}).strict();

export const CourseVisibilityStateSchema = CourseVisibilityReceiptSchema.extend({
  currentReadyVersionId: IdSchema.nullable(),
  progress: AccountProgressSchema,
}).strict();

export type CourseVisibilityInput = z.infer<typeof CourseVisibilityInputSchema>;
export type CourseVisibilityReceipt = z.infer<typeof CourseVisibilityReceiptSchema>;
export type CourseVisibilityState = z.infer<typeof CourseVisibilityStateSchema>;
