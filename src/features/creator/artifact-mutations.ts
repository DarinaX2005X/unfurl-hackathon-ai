import { CourseArtifactRefSchema, type CourseArtifactRef, type EditCourseMetadata, type EditCourseMetadataInput } from "@/domain/chat";
import { assertCurrentApproval } from "@/domain/course";

/** The acknowledgement belongs to the captured course, independent of panel selection. */
export async function editExistingCourseMetadata(
  original: CourseArtifactRef,
  input: Omit<EditCourseMetadataInput, "courseId" | "expectedRevision">,
  getCurrent: (courseId: string) => CourseArtifactRef | undefined,
  edit: EditCourseMetadata,
): Promise<CourseArtifactRef> {
  const isCurrent = () => getCurrent(original.courseId)?.revision === original.revision;
  if (!isCurrent()) throw new Error("The course changed. Reopen its details.");
  const result = CourseArtifactRefSchema.parse(await edit({ ...input, courseId: original.courseId, expectedRevision: original.revision }));
  if (!isCurrent() || result.courseId !== original.courseId || result.revision <= original.revision) throw new Error("The course update was not confirmed.");
  if (result.title !== input.title.trim() || result.summary !== input.summary.trim() || result.contentLanguage !== input.contentLanguage) throw new Error("The course update did not match these details.");
  const programChanged = input.title.trim() !== original.title || input.contentLanguage !== original.contentLanguage;
  if (programChanged && original.curriculum) {
    if (!result.curriculum || result.curriculum.id !== original.curriculum.id || result.curriculum.revision <= original.curriculum.revision
      || result.curriculum.title !== result.title || result.curriculum.contentLanguage !== result.contentLanguage) {
      throw new Error("The program needs an updated revision for these details.");
    }
  }
  if (result.approval) {
    if (!result.curriculum) throw new Error("Approval needs a program.");
    await assertCurrentApproval(result.curriculum, result.approval);
  }
  return result;
}
