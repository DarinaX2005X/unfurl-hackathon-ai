import type { NextRequest } from "next/server";
import { approveCurriculumRoute } from "@/server/curricula/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, context: Context) { return approveCurriculumRoute(request, (await context.params).id); }
