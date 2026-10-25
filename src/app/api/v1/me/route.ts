import type { NextRequest } from "next/server";
import { handleAccountState } from "@/server/auth/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { return handleAccountState(request); }
