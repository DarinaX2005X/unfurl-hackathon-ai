import type { NextRequest } from "next/server";
import { runEventsRoute } from "@/server/runs/routes";
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return runEventsRoute(request, (await context.params).id, "agent_turn");
}
