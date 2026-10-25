import type { NextRequest } from "next/server";
import { revokeShareRoute } from "@/server/sharing/routes";
export const dynamic = "force-dynamic";
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; shareId: string }> }) {
  const params = await context.params;
  return revokeShareRoute(request, params.id, params.shareId);
}
