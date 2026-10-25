import type { NextRequest } from "next/server";
import { respondToSupportRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; offerId: string }> }) {
  const params = await context.params;
  return respondToSupportRoute(request, params.id, params.offerId);
}
