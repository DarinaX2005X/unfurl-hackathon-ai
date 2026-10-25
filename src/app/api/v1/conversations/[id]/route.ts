import type { NextRequest } from "next/server";
import { getConversationRoute, renameConversationRoute, deleteConversationRoute } from "@/server/conversations/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) { return getConversationRoute(request, (await context.params).id); }
export async function PATCH(request: NextRequest, context: Context) { return renameConversationRoute(request, (await context.params).id); }
export async function DELETE(request: NextRequest, context: Context) { return deleteConversationRoute(request, (await context.params).id); }
