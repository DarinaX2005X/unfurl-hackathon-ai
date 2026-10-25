import type { NextRequest } from "next/server";
import { retryReviewRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; reviewId: string }> }) {
  const params = await context.params;
  return retryReviewRoute(request, params.id, params.reviewId);
}
