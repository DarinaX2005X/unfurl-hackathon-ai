import type { NextRequest } from "next/server";
import { startActivityRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return startActivityRoute(request, params.id);
}

