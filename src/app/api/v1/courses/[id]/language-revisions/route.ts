import type { NextRequest } from "next/server";
import { requestCourseLanguageRoute } from "@/server/curricula/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, context: Context) { return requestCourseLanguageRoute(request, (await context.params).id); }
