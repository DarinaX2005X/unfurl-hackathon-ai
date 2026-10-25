import "server-only";
import type { NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import { EnrollmentInputSchema } from "../../domain/catalog";
import { requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { ServiceFault } from "../auth/errors";
import { enrollmentService } from "./service";

export async function createEnrollmentRoute(request: NextRequest, courseId: string) {
  try {
    assertSameOrigin(request);
    const key = IdSchema.safeParse(request.headers.get("Idempotency-Key"));
    if (!key.success) throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
    const receipt = await enrollmentService.enroll(await requireActor(), courseId,
      await readInput(request, EnrollmentInputSchema), key.data);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
