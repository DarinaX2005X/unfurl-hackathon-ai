import type { NextRequest } from "next/server";
import { saveComposerRoute } from "@/server/conversations/routes";
export const runtime = "nodejs";
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) { return saveComposerRoute(request, (await context.params).id); }
