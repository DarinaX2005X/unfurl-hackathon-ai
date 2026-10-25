import type { NextRequest } from "next/server";
import { patchCourseMetadataRoute } from "@/server/curricula/routes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: NextRequest, context: Context) { return patchCourseMetadataRoute(request, (await context.params).id); }
