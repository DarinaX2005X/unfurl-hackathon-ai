import "server-only";
import { createHash } from "node:crypto";
import type { JsonValue } from "../../domain/common";
import { ProviderFailure } from "./failure";

export function digestBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bounded canonical JSON is used for request identity, never a token-count estimate. */
export function canonicalJson(value: unknown, maxBytes = 256 * 1024): string {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (++nodes > 50_000 || depth > 32) throw new ProviderFailure("invalid_output");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) throw new ProviderFailure("invalid_output");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new ProviderFailure("invalid_output");
    }
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${Array.from(item, (child) => visit(child, depth + 1)).join(",")}]`;
    else {
      result = `{${Object.keys(item).sort().map((key) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new ProviderFailure("invalid_output");
        return `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`;
      }).join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ProviderFailure("invalid_output");
  return result;
}

export function jsonDigest(value: unknown, maxBytes?: number): string {
  return digestBytes(canonicalJson(value, maxBytes));
}

/** Decode structured content without changing its saved receipt or repairing JSON syntax. */
export function parseStructuredOutput(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { /* A whole JSON fence is the only accepted wrapper. */ }
  const fenced = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/i.exec(content.trim());
  if (!fenced) throw new ProviderFailure("invalid_output");
  try { return JSON.parse(fenced[1]!) as unknown; } catch { throw new ProviderFailure("invalid_output"); }
}

/** Preserve the provider's exact decimal cost token before JSON.parse rounds numbers. */
export function parseProviderJson(text: string): unknown {
  const moneyKeys = new Set(["cost", "total_cost", "upstream_inference_cost"]);
  let output = "";
  let offset = 0;
  try {
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '"') continue;
      const start = index++;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index] === '"') break;
        index++;
      }
      const key = JSON.parse(text.slice(start, index + 1)) as unknown;
      if (typeof key !== "string" || !moneyKeys.has(key)) continue;
      let cursor = index + 1;
      while (/\s/.test(text[cursor] ?? "x")) cursor++;
      if (text[cursor] !== ":") continue;
      cursor++;
      while (/\s/.test(text[cursor] ?? "x")) cursor++;
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor));
      if (!number) continue;
      output += text.slice(offset, cursor) + JSON.stringify(number[0]);
      offset = cursor + number[0].length;
      index = offset - 1;
    }
    return JSON.parse(output + text.slice(offset)) as JsonValue;
  } catch { throw new ProviderFailure("invalid_output"); }
}

