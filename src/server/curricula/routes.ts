import "server-only";
import type { NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import { ApproveCurriculumInputSchema, EditCourseMetadataInputSchema, PatchCurriculumInputSchema, RequestCourseLanguageInputSchema } from "../../domain/curriculum-authoring";
import { requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { ServiceFault } from "../auth/errors";
import { curriculumService } from "./service";

function identity(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new ServiceFault(400, "invalid_input", "curriculum.invalidInput");
  return parsed.data;
}
const key = (request: Request) => identity(request.headers.get("Idempotency-Key"));
export async function getCurriculumRoute(request: NextRequest, id: string) {
  try { return success(await curriculumService.get(await requireActor(), identity(id))); }
  catch (error) { return failure(error, request); }
}
export async function patchCurriculumRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, PatchCurriculumInputSchema, { maxBytes: 2_000_000 });
    const receipt = await curriculumService.patch(actor, identity(id), input, key(request), request.signal);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function approveCurriculumRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const input = await readInput(request, ApproveCurriculumInputSchema);
    const receipt = await curriculumService.approve(actor, identity(id), input, key(request));
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
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
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
