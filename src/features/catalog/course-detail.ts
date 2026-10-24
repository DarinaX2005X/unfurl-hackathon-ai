import type { ApplicationPort } from "@/application/ports";
import type { CourseDetailPublic } from "@/domain";

export type CourseDetailResult = { kind: "ready"; course: CourseDetailPublic } | { kind: "unavailable" } | { kind: "error" };
export async function loadCourseDetail(service: ApplicationPort, slug: string, signal: AbortSignal): Promise<CourseDetailResult> {
  signal.throwIfAborted();
  try {
    const result = await service.getPublicCourse(slug, signal);
    signal.throwIfAborted();
    if (result.ok) return { kind: "ready", course: result.data };
    return { kind: ["not_found", "forbidden", "unauthenticated"].includes(result.error.error.code) ? "unavailable" : "error" };
  } catch {
    signal.throwIfAborted();
    return { kind: "error" };
  }
}
