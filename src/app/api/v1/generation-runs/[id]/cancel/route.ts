import type { NextRequest } from "next/server";
import { cancelRunRoute } from "@/server/runs/routes";
export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return cancelRunRoute(request, (await context.params).id, "generation");
}
