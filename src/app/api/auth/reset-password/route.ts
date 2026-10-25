import type { NextRequest } from "next/server";
import { handleAuthMutation } from "@/server/auth/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: NextRequest) { return handleAuthMutation(request, "reset-password"); }
