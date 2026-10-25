import type { NextRequest } from "next/server";
import { requestFreshAssessmentRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return requestFreshAssessmentRoute(request, (await context.params).id);
}
