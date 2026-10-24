import type { Metadata } from "next";
import { CreatorWorkspace } from "@/features/creator/CreatorWorkspace";

export const metadata: Metadata = { title: "Create a course | Unfurl", description: "Start a course with your own learning goal." };

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const query = await searchParams;
  const draftId = Array.isArray(query.draft) ? "invalid" : query.draft ?? null;
  return <CreatorWorkspace key={draftId ?? "new"} draftId={draftId} />;
}
