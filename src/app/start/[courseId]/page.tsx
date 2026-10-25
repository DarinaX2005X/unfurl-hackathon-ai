import type { Metadata } from "next";
import { IdSchema } from "@/domain/common";
import { StartCourseContinuation } from "@/features/catalog/StartCourseContinuation";

export const metadata: Metadata = { title: "Start course | Unfurl", referrer: "no-referrer" };
export default async function StartCourseRoute({ params, searchParams }: {
  params: Promise<{ courseId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { courseId } = await params;
  const query = await searchParams;
  const version = typeof query.version === "string" ? query.version : "";
  const share = typeof query.share === "string" ? query.share : undefined;
  const valid = IdSchema.safeParse(courseId).success && IdSchema.safeParse(version).success
    && (share === undefined || /^[A-Za-z0-9_-]{43}$/.test(share));
  return <StartCourseContinuation courseId={courseId} versionId={version} {...(share ? { shareToken: share } : {})} valid={valid} />;
}
