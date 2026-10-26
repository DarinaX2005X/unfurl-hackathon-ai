import "server-only";
import { IdSchema } from "@/domain/common";
import type { CourseDetailResult } from "@/domain/catalog";
import { catalogService } from "./service";

type FeaturedEnvironment = {
  FEATURED_AI_COURSE_ID?: string;
  FEATURED_AI_COURSE_VERSION_ID?: string;
};

type FeaturedCourseLoader = (courseId: string, courseVersionId: string) => Promise<CourseDetailResult>;

export type FeaturedCourseResolution =
  | { kind: "ready"; courseId: string; courseVersionId: string; slug: string }
  | { kind: "unavailable" };

const unavailable = (): FeaturedCourseResolution => ({ kind: "unavailable" });

export async function resolveFeaturedCourse(options: {
  env?: FeaturedEnvironment;
  loadCourse?: FeaturedCourseLoader;
} = {}): Promise<FeaturedCourseResolution> {
  const env = options.env ?? process.env;
  const courseId = IdSchema.safeParse(env.FEATURED_AI_COURSE_ID);
  const courseVersionId = IdSchema.safeParse(env.FEATURED_AI_COURSE_VERSION_ID);
  if (!courseId.success || !courseVersionId.success) return unavailable();

  const loadCourse = options.loadCourse ?? ((id, versionId) => catalogService.getCourse(null, id, versionId));
  try {
    const result = await loadCourse(courseId.data, courseVersionId.data);
    if (result.kind !== "ready" || result.detail.access !== "public"
      || result.detail.course.visibility !== "public" || result.detail.course.id !== courseId.data
      || result.detail.version.id !== courseVersionId.data) return unavailable();
    return { kind: "ready", courseId: courseId.data, courseVersionId: courseVersionId.data, slug: result.detail.course.slug };
  } catch {
    return unavailable();
  }
}
