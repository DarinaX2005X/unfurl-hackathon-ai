import type { NextRequest } from "next/server";
import { getCourseBySlugRoute } from "@/server/catalog/routes";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  return getCourseBySlugRoute(request, (await context.params).slug);
}
