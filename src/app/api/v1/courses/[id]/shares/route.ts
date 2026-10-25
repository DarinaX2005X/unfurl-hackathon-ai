import type { NextRequest } from "next/server";
import { createShareRoute, listSharesRoute } from "@/server/sharing/routes";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return listSharesRoute(request, (await context.params).id);
}
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return createShareRoute(request, (await context.params).id);
}
