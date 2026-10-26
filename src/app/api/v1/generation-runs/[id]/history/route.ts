import { type NextRequest } from "next/server";
import { IdSchema } from "@/domain/common";
import { requireActor } from "@/server/auth/session";
import { failure, success } from "@/server/auth/http";
import { ServiceFault } from "@/server/auth/errors";
import { withSystemTransaction } from "@/server/db";
import { readGenerationHistory } from "@/server/runs/observer";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(), id = IdSchema.safeParse((await context.params).id);
    const invalid = () => new ServiceFault(400, "invalid_input", "generation.invalidInput");
    if (!id.success) throw invalid();
    for (const key of request.nextUrl.searchParams.keys())
      if (!["before", "limit"].includes(key) || request.nextUrl.searchParams.getAll(key).length !== 1) throw invalid();
    const before = request.nextUrl.searchParams.get("before"), limit = request.nextUrl.searchParams.get("limit");
    if ((before !== null && (!/^[1-9][0-9]{0,9}$/.test(before) || Number(before) > 2147483647))
      || (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))) throw invalid();
    const data = await withSystemTransaction("run_execution", tx => readGenerationHistory(tx, actor, id.data,
      { ...(before ? { before: Number(before) } : {}), ...(limit ? { limit: Number(limit) } : {}) }));
    return success(data);
  } catch (error) { return failure(error, request); }
}
