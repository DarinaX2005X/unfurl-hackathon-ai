import type { ServiceResult } from "@/application/ports";
import type { CourseVisibilityInput, CourseVisibilityReceipt, CourseVisibilityState } from "@/domain/progression";

export interface VisibilityIntent { key: string; input: CourseVisibilityInput }

export function visibilityIntent(current: VisibilityIntent | null, input: CourseVisibilityInput,
  createKey: () => string = () => crypto.randomUUID()): VisibilityIntent {
  if (current) return current;
  return { key: createKey(), input };
}

/** A retryable response may hide a committed write, so only a conclusive response releases this identity. */
export function settleVisibilityIntent(intent: VisibilityIntent,
  result: ServiceResult<CourseVisibilityReceipt>): VisibilityIntent | null {
  return !result.ok && result.error.error.retryable ? intent : null;
}

export function visibilityIntentIsSaved(intent: VisibilityIntent, state: CourseVisibilityState): boolean {
  const publishedVersionId = intent.input.visibility === "public" ? intent.input.courseVersionId : null;
  return state.visibility === intent.input.visibility && state.publishedVersionId === publishedVersionId;
}
