import type { Page } from "../domain/common";
import type { AccessibleCourseDetail, CourseSummary } from "../domain/course";
import type {
  CatalogQuery, CourseDetailResult, CreateShareInput, EnrollmentInput, EnrollmentReceipt,
  LibraryCourseItem, LibraryQuery, ShareCreated, ShareList,
} from "../domain/catalog";
import type { ServiceResult } from "./ports";

export interface CatalogPort {
  listPublic(query: CatalogQuery, signal?: AbortSignal): Promise<ServiceResult<Page<CourseSummary>>>;
  getBySlug(slug: string, signal?: AbortSignal): Promise<ServiceResult<CourseDetailResult>>;
  getCourse(courseId: string, versionId?: string, signal?: AbortSignal): Promise<ServiceResult<CourseDetailResult>>;
  resolveShare(token: string, signal?: AbortSignal): Promise<ServiceResult<AccessibleCourseDetail>>;
  listLibrary(query: LibraryQuery, signal?: AbortSignal): Promise<ServiceResult<Page<LibraryCourseItem>>>;
  createEnrollment(courseId: string, input: EnrollmentInput, idempotencyKey: string, signal?: AbortSignal): Promise<ServiceResult<EnrollmentReceipt>>;
  listShares(courseId: string, signal?: AbortSignal): Promise<ServiceResult<ShareList>>;
  createShare(courseId: string, input: CreateShareInput, idempotencyKey: string, signal?: AbortSignal): Promise<ServiceResult<ShareCreated>>;
  revokeShare(courseId: string, shareId: string, signal?: AbortSignal): Promise<ServiceResult<null>>;
}
