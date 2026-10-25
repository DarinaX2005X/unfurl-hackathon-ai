import "server-only";
import { createHash } from "node:crypto";

/** Stable across object key order; rejects non-JSON values instead of silently dropping authored fields. */
export function canonicalTaskJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTaskJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTaskJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Expected finite JSON data");
}
export function taskDigest(value: unknown): string {
  return createHash("sha256").update(canonicalTaskJson(value)).digest("hex");
}
