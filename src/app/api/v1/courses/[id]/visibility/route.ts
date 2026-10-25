import type { NextRequest } from "next/server";
import { IdSchema } from "@/domain/common";
import { CourseVisibilityInputSchema } from "@/domain/progression";
import { ServiceFault } from "@/server/auth/errors";
import { assertSameOrigin, failure, readInput, success } from "@/server/auth/http";
import { requireActor } from "@/server/auth/session";
import { publicationService } from "@/server/publication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = IdSchema.safeParse(request.headers.get("Idempotency-Key"));
    if (!key.success) throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
    const body = await readInput(request, CourseVisibilityInputSchema);
    const receipt = await publicationService.setVisibility(actor, (await context.params).id, body, key.data);
    return success(receipt.data, receipt.status);
  } catch (error) {
    return failure(error, request);
  }
}
