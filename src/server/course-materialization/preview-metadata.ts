import "server-only";
import { z } from "zod";
import { DigestSchema, IdSchema } from "@/domain/common";
import { CoursePreviewReleaseSchema, type CourseVersion } from "@/domain/course";
import { taskDigest } from "@/server/mechanics/digest";

export const OfficialPreviewMetadataSchema = z.object({
  kind: z.literal("official-section-preview-v1"), publisher: z.literal("Unfurl"),
  sourceRunId: IdSchema, approvalId: IdSchema, approvalDigest: DigestSchema, courseVersionId: IdSchema,
  completedStepId: IdSchema, moduleDigest: DigestSchema, releaseDigest: DigestSchema,
  presentation: CoursePreviewReleaseSchema,
}).strict();
export type OfficialPreviewMetadata = z.infer<typeof OfficialPreviewMetadataSchema>;

export function previewFromVersion(value: unknown, version: CourseVersion): OfficialPreviewMetadata | null {
  if (value === null || value === undefined) return null;
  const metadata = OfficialPreviewMetadataSchema.parse(value);
  const { releaseDigest, ...body } = metadata;
  if (taskDigest(body) !== releaseDigest || metadata.courseVersionId !== version.id || metadata.sourceRunId !== version.sourceRunId
    || metadata.approvalId !== version.approvalId || metadata.approvalDigest !== version.contentDigest
    || taskDigest(metadata.presentation.availableModuleIds) !== taskDigest(version.modules.map(({ id }) => id))
    || metadata.presentation.lessons.length !== version.lessonIds.length
    || metadata.presentation.lessons.some(({ id }) => !version.lessonIds.includes(id))) throw new Error("Invalid course preview metadata");
  return metadata;
}
