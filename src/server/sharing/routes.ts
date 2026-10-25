import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import { CreateShareInputSchema } from "../../domain/catalog";
import { getActor, requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { privateResponse } from "../auth/client";
import { ServiceFault } from "../auth/errors";
import { sharingService } from "./service";

function keyFor(request: Request): string {
  const key = IdSchema.safeParse(request.headers.get("Idempotency-Key"));
  if (!key.success) throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
  return key.data;
}

export async function listSharesRoute(request: NextRequest, courseId: string) {
  try { return success(await sharingService.list(await requireActor(), courseId)); }
  catch (error) { return failure(error, request); }
}
export async function createShareRoute(request: NextRequest, courseId: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const receipt = await sharingService.create(actor, courseId, await readInput(request, CreateShareInputSchema), keyFor(request));
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function revokeShareRoute(request: NextRequest, courseId: string, shareId: string) {
  try {
    assertSameOrigin(request);
    await requireActor().then((actor) => sharingService.revoke(actor, courseId, shareId));
    return privateResponse(new NextResponse(null, { status: 204 }));
  } catch (error) { return failure(error, request); }
}
export async function resolveShareRoute(request: NextRequest, token: string) {
  try { return success(await sharingService.resolve(await getActor(), token)); }
  catch (error) { return failure(error, request); }
}
