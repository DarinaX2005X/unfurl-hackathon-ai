import type { Id } from "../domain/common";
import type { CourseArtifactRef } from "../domain/chat";
import type {
  ApproveCurriculumInput,
  CourseLanguageRequestResult,
  CourseMetadataInput,
  CurriculumApprovalResult,
  CurriculumAuthoringSnapshot,
  CurriculumMutationResult,
  PatchCurriculumInput,
  RequestCourseLanguageInput,
} from "../domain/curriculum-authoring";
import type { ServiceResult } from "./ports";

export interface CurriculumMutationOptions {
  idempotencyKey: Id;
  signal?: AbortSignal;
}

/** The authenticated authoring boundary. It never accepts a whole course or an approval invented by the browser. */
export interface CurriculumPort {
  getCurriculum(draftId: Id, signal?: AbortSignal): Promise<ServiceResult<CurriculumAuthoringSnapshot>>;
  patchCurriculum(
    draftId: Id,
    input: PatchCurriculumInput,
    options: CurriculumMutationOptions,
  ): Promise<ServiceResult<CurriculumMutationResult>>;
  approveCurriculum(
    draftId: Id,
    input: ApproveCurriculumInput,
    options: CurriculumMutationOptions,
  ): Promise<ServiceResult<CurriculumApprovalResult>>;
  editCourseMetadata(
    courseId: Id,
    input: CourseMetadataInput,
    options: CurriculumMutationOptions,
  ): Promise<ServiceResult<CourseArtifactRef>>;
  requestCourseLanguage(
    courseId: Id,
    input: RequestCourseLanguageInput,
    options: CurriculumMutationOptions,
  ): Promise<ServiceResult<CourseLanguageRequestResult>>;
}
