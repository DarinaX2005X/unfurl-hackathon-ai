import { notFound } from "next/navigation";
import { IdSchema } from "@/domain/common";
import { ProductionPlayer } from "@/features/learning/player/ProductionPlayer";

export const metadata = { title: "Learn | Unfurl" };

export default async function LearnRoute({ params }: { params: Promise<{ enrollmentId: string }> }) {
  const { enrollmentId } = await params;
  if (!IdSchema.safeParse(enrollmentId).success) notFound();
  return <ProductionPlayer enrollmentId={enrollmentId} />;
}
