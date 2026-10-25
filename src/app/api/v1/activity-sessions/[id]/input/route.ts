import type { NextRequest } from "next/server";
import { saveInputRoute } from "@/server/learning/routes";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return saveInputRoute(request, params.id);
}

