import type { NextRequest } from "next/server";
import { retryRunRoute } from "@/server/runs/routes";
export const runtime="nodejs";
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){return retryRunRoute(request,(await context.params).id,"generation");}
