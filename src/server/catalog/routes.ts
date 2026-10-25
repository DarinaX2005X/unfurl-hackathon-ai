import "server-only";
import type { NextRequest } from "next/server";
import { CatalogQuerySchema, LibraryQuerySchema } from "../../domain/catalog";
import { getActor, requireActor } from "../auth/session";
import { failure, success } from "../auth/http";
import { ServiceFault } from "../auth/errors";
import { catalogService } from "./service";
import { withSystemTransaction } from "../db";
import { listLibrary } from "./library";

function exactQuery(request: NextRequest, allowed: readonly string[]): URLSearchParams {
  const params = request.nextUrl.searchParams;
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) {
    throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
  }
  return params;
}
function catalogQuery(params: URLSearchParams) {
  const result = CatalogQuerySchema.safeParse({
    ...(params.has("q") ? { q: params.get("q") } : {}),
    ...(params.has("contentLanguage") ? { contentLanguage: params.get("contentLanguage") } : {}),
    ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
    ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
  });
  if (!result.success) throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
  return result.data;
}

export async function listCatalogRoute(request: NextRequest) {
  try { return success(await catalogService.listPublic(catalogQuery(exactQuery(request, ["q", "contentLanguage", "cursor", "limit"])))); }
  catch (error) { return failure(error, request); }
}

export async function getCourseBySlugRoute(request: NextRequest, slug: string) {
  try {
    exactQuery(request, []);
    return success(await catalogService.getBySlug(await getActor(), slug));
  } catch (error) { return failure(error, request); }
}

export async function getCourseRoute(request: NextRequest, courseId: string) {
  try {
    const params = exactQuery(request, ["version"]);
    return success(await catalogService.getCourse(await getActor(), courseId, params.get("version") ?? undefined));
  } catch (error) { return failure(error, request); }
}

export async function listLibraryRoute(request: NextRequest) {
  try {
    const actor = await requireActor();
    const params = exactQuery(request, ["view", "q", "contentLanguage", "cursor", "limit"]);
    const result = LibraryQuerySchema.safeParse({ ...catalogQuery(params), ...(params.has("view") ? { view: params.get("view") } : {}) });
    if (!result.success) throw new ServiceFault(400, "invalid_input", "catalog.invalidInput");
    return success(await withSystemTransaction("public_projection", (tx) => listLibrary(tx, actor, result.data)));
  } catch (error) { return failure(error, request); }
}
