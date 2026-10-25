import type { NextRequest } from "next/server";
import { requestReviewRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return requestReviewRoute(request, params.id);
}
