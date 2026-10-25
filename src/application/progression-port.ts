import type { Id } from "../domain/common";
import type { AccountProgress } from "../domain/learning";
import type {
  CourseVisibilityInput,
  CourseVisibilityReceipt,
  CourseVisibilityState,
} from "../domain/progression";
import type { ServiceResult } from "./ports";

export type ProgressionMutationOptions = { idempotencyKey: Id; signal?: AbortSignal };

export interface ProgressionPort {
  getAccountProgress(signal?: AbortSignal): Promise<ServiceResult<AccountProgress>>;
  getCourseVisibility(courseId: Id, signal?: AbortSignal): Promise<ServiceResult<CourseVisibilityState>>;
  setVisibility(
    courseId: Id,
    input: CourseVisibilityInput,
    options: ProgressionMutationOptions,
  ): Promise<ServiceResult<CourseVisibilityReceipt>>;
}
