import type { NextRequest } from "next/server";
import { getCurriculumRoute, patchCurriculumRoute } from "@/server/curricula/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) { return getCurriculumRoute(request, (await context.params).id); }
export async function PATCH(request: NextRequest, context: Context) { return patchCurriculumRoute(request, (await context.params).id); }
