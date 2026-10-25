import { z } from "zod";
import { IdSchema, RevisionSchema, VisibilitySchema } from "./common";

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

export type CourseVisibilityInput = z.infer<typeof CourseVisibilityInputSchema>;
export type CourseVisibilityReceipt = z.infer<typeof CourseVisibilityReceiptSchema>;
