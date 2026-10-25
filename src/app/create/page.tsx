import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";

export default async function CreatePage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const query = await searchParams;
  const legacyId = Array.isArray(query.draft) ? "invalid" : query.draft;
  redirect(legacyId !== undefined ? `/chat?import=${encodeURIComponent(legacyId)}` : routes.chat());
}
