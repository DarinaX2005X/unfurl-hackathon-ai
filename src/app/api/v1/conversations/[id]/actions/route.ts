import type { NextRequest } from "next/server";
import { getConversationActionsRoute } from "@/server/conversations/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) { return getConversationActionsRoute(request, (await context.params).id); }
