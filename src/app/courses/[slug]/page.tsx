import { CourseDetailPage } from "@/features/catalog/CourseDetailPage";
export const metadata = { title: "Course | Unfurl" };
export default async function CourseRoute({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; return <CourseDetailPage key={slug} slug={slug} />; }
