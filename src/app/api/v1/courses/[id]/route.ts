import type { NextRequest } from "next/server";
import { getCourseRoute } from "@/server/catalog/routes";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return getCourseRoute(request, (await context.params).id);
}
