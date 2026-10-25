import type { NextRequest } from "next/server";
import { handleProfileUpdate } from "@/server/auth/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function PATCH(request: NextRequest) { return handleProfileUpdate(request); }
