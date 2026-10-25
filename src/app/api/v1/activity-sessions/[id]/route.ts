import type { NextRequest } from "next/server";
import { getActivityRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return getActivityRoute(request, params.id);
}

