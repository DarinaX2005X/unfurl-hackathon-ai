import type { NextRequest } from "next/server";
import { retryActionRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; receiptId: string }> }) {
  const params = await context.params;
  return retryActionRoute(request, params.id, params.receiptId);
}

