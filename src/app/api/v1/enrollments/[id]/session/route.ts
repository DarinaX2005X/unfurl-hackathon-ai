import type { NextRequest } from "next/server";
import { loadSessionRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return loadSessionRoute(request, params.id);
}

