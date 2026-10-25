import type { NextRequest } from "next/server";
import { createEnrollmentRoute } from "@/server/enrollments/routes";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return createEnrollmentRoute(request, (await context.params).id);
}
