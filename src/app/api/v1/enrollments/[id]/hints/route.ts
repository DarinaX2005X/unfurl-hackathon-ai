import type { NextRequest } from "next/server";
import { requestHintRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return requestHintRoute(request, params.id);
}
