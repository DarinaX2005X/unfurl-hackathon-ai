import "server-only";
import { dispatchAfterResponse } from "../runs/dispatch-after-response";
import type { NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import { ApproveCurriculumInputSchema, EditCourseMetadataInputSchema, PatchCurriculumInputSchema, RequestCourseLanguageInputSchema } from "../../domain/curriculum-authoring";
import { requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { ServiceFault, unavailable } from "../auth/errors";
import { ProviderFailure, publicProviderFault } from "../ai/failure";
import { curriculumService } from "./service";

function identity(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new ServiceFault(400, "invalid_input", "curriculum.invalidInput");
  return parsed.data;
}
const key = (request: Request) => identity(request.headers.get("Idempotency-Key"));
export async function getCurriculumRoute(request: NextRequest, id: string) {
  try { const actor=await requireActor();const data=await curriculumService.get(actor,identity(id));dispatchAfterResponse(actor);return success(data); }
  catch (error) { return failure(error, request); }
}
export async function patchCurriculumRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, PatchCurriculumInputSchema, { maxBytes: 2_000_000 });
    const receipt = await curriculumService.patch(actor, identity(id), input, key(request));
    if("run" in receipt.data)dispatchAfterResponse(actor,receipt.data.run.id);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function approveCurriculumRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, ApproveCurriculumInputSchema);
    const receipt = await curriculumService.approve(actor, identity(id), input, key(request));
    dispatchAfterResponse(actor,receipt.data.run.id);
    return success(receipt.data, receipt.status);
  } catch (error) {
    return failure(error instanceof ProviderFailure
      ? publicProviderFault(error) ?? unavailable("generation.unavailable")
      : error, request);
  }
}
export async function patchCourseMetadataRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, EditCourseMetadataInputSchema);
    const receipt = await curriculumService.metadata(actor, identity(id), input, key(request));
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function requestCourseLanguageRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, RequestCourseLanguageInputSchema);
    const receipt = await curriculumService.language(actor, identity(id), input, key(request));
    dispatchAfterResponse(actor,receipt.data.run.id);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
