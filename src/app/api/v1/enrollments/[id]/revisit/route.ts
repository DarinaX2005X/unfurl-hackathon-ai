import type { NextRequest } from "next/server";
import { revisitRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return revisitRoute(request, (await context.params).id);
}
