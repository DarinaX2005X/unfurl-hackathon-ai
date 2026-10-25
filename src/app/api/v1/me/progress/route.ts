import type { NextRequest } from "next/server";
import { failure, success } from "@/server/auth/http";
import { requireActor } from "@/server/auth/session";
import { readAccountProgress } from "@/server/progression";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor();
    return success(await readAccountProgress(actor.id));
  } catch (error) {
    return failure(error, request);
  }
}
