import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen } from "lucide-react";
import { PublicHeader } from "@/components/shell";
import { LinkButton } from "@/components/ui";
import { startCoursePath } from "@/features/catalog/paths";
import { routes } from "@/lib/routes";
import { resolveFeaturedCourse } from "@/server/catalog/featured";
import "./try.css";

export const metadata: Metadata = { title: "Try the featured AI course | Unfurl", description: "Start Unfurl’s featured course about artificial intelligence." };
export const dynamic = "force-dynamic";

export default async function TryPage() {
  const featured = await resolveFeaturedCourse();
  if (featured.kind === "ready") redirect(startCoursePath(featured.courseId, featured.courseVersionId));

  return <><PublicHeader /><main id="main-content" className="try-page">
    <section className="try-unavailable" aria-labelledby="try-unavailable-title">
      <BookOpen className="try-unavailable__mark" size={36} strokeWidth={1.5} aria-hidden="true" />
      <h1 id="try-unavailable-title">The featured AI course isn’t available right now</h1>
      <p className="try-unavailable__copy">Explore other published courses, or create a course around something you want to understand.</p>
      <div className="try-unavailable__actions">
        <LinkButton href={routes.explore}>Explore courses</LinkButton>
        <Link href={routes.create()} className="uf-text-link">Create your own course</Link>
      </div>
    </section>
  </main></>;
}
