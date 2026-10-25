import { ContentLanguageSchema, IdSchema } from "../domain/common";

const unsafeCharacters = /[\\\u0000-\u001f\u007f]/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const shareToken = /^[A-Za-z0-9_-]{43,128}$/;
const uuid = (value: string) => IdSchema.safeParse(value).success;

/** Rebuilds a supported destination; arbitrary redirect URLs are never forwarded. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (unsafeCharacters.test(value) || value.includes("#")) return "/";
  const rawPath = value.split("?")[0]!;
  if (rawPath.includes("%") || rawPath.split("/").some((part) => part === "." || part === "..")) return "/";

  let url: URL;
  try { url = new URL(value, "https://return.invalid"); } catch { return "/"; }
  if (url.origin !== "https://return.invalid" || url.username || url.password || url.pathname !== rawPath) return "/";
  const params = url.searchParams;
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size || [...params.values()].some((item) => unsafeCharacters.test(item))) return "/";
  // URLSearchParams otherwise silently repairs malformed percent escapes.
  if (/%(?![\da-f]{2})/i.test(url.search)) return "/";

  let validators: Record<string, (item: string) => boolean> = {};
  let required: string[] = [];
  const path = url.pathname;
  if (path === "/" || path === "/account") {
    validators = {};
  } else if (path === "/chat") {
    validators = { conversation: uuid };
  } else if (path === "/library") {
    validators = { view: (item) => ["all", "courses", "in_progress"].includes(item) };
  } else if (path === "/explore") {
    validators = { q: (item) => item.length <= 200, contentLanguage: (item) => ContentLanguageSchema.safeParse(item).success };
  } else if (path.startsWith("/courses/") && path.slice(9).length <= 160 && slug.test(path.slice(9))) {
    validators = {};
  } else if (path.startsWith("/learn/") && uuid(path.slice(7))) {
    validators = {};
  } else if (path.startsWith("/start/") && uuid(path.slice(7))) {
    validators = { version: uuid, share: (item) => shareToken.test(item) };
    required = ["version"];
  } else if (path.startsWith("/s/") && shareToken.test(path.slice(3))) {
    validators = {};
  } else {
    return "/";
  }

  if (required.some((key) => !params.has(key))) return "/";
  if (keys.some((key) => !Object.hasOwn(validators, key) || !validators[key]!(params.get(key)!))) return "/";
  const clean = new URLSearchParams();
  for (const key of Object.keys(validators)) {
    const item = params.get(key);
    if (item !== null) clean.set(key, item);
  }
  const query = clean.toString();
  return query ? `${path}?${query}` : path;
}
