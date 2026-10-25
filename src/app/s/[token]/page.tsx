import type { Metadata } from "next";
import { CourseDetailPage } from "@/features/catalog/CourseDetailPage";

export const metadata: Metadata = { title: "Shared course | Unfurl", referrer: "no-referrer" };
export default async function SharedCourseRoute({ params }: { params: Promise<{ token: string }> }) {
  return <CourseDetailPage shareToken={(await params).token} />;
}
