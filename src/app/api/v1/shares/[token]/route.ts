import type { NextRequest } from "next/server";
import { resolveShareRoute } from "@/server/sharing/routes";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return resolveShareRoute(request, (await context.params).token);
}
