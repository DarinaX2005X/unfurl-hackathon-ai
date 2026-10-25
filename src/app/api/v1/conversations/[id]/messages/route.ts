import type { NextRequest } from "next/server";
import { sendMessageRoute } from "@/server/conversations/routes";
export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) { return sendMessageRoute(request, (await context.params).id); }
