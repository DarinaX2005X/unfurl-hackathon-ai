import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, JsonValueSchema, type JsonValue } from "../../domain/common";
import { ServiceFault } from "../auth/errors";

const CursorSchema = z.object({
  kind: z.enum(["catalog-v1", "library-v1"]),
  sortAt: IsoDateTimeSchema,
  id: IdSchema,
  filters: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CatalogCursor = z.infer<typeof CursorSchema>;

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cursorFilters(value: unknown): string {
  const parsed = JsonValueSchema.parse(value);
  return createHash("sha256").update(canonical(parsed)).digest("hex");
}

export function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(CursorSchema.parse(cursor)), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined, kind: CatalogCursor["kind"], filters: string): CatalogCursor | null {
  if (value === undefined) return null;
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) throw new Error("noncanonical");
    const parsed = CursorSchema.parse(JSON.parse(json));
    if (parsed.kind !== kind || parsed.filters !== filters) throw new Error("mismatch");
    return parsed;
  } catch {
    throw new ServiceFault(400, "invalid_input", "catalog.invalidCursor");
  }
}
