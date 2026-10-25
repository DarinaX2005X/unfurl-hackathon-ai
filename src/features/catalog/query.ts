import { ContentLanguageSchema } from "@/domain";
import type { CatalogQuery, LibraryView } from "@/domain/catalog";

export type { LibraryView } from "@/domain/catalog";
export function readCourseQuery(params: Pick<URLSearchParams, "get">): CatalogQuery {
  const q = params.get("q")?.trim().slice(0, 200);
  const language = params.get("contentLanguage");
  return { ...(q ? { q } : {}), ...(language && ContentLanguageSchema.safeParse(language).success ? { contentLanguage: language } : {}) };
}
export function readLibraryView(params: Pick<URLSearchParams, "get">): LibraryView {
  const view = params.get("view");
  return view === "courses" || view === "in_progress" ? view : "all";
}
export function updateCollectionQuery(current: string, values: { q?: string; contentLanguage?: string; view?: LibraryView }): string {
  const params = new URLSearchParams(current);
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (value && !(key === "view" && value === "all")) params.set(key, value);
    else params.delete(key);
  }
  params.delete("cursor");
  const query = params.toString();
  return query ? `?${query}` : "";
}
export function resetLibraryFilters(current: string): string {
  return updateCollectionQuery(current, { q: "", contentLanguage: "" });
}
export function showAllLibraryCourses(current: string): string {
  return updateCollectionQuery(current, { q: "", contentLanguage: "", view: "all" });
}
export function languageName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}
export function studyTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60), rest = Math.round(minutes % 60);
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}
