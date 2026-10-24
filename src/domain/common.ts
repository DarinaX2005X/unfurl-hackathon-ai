import { z } from "zod";

export const IdSchema = z.uuid();
export const IsoDateTimeSchema = z.iso.datetime({ offset: false });
export const RevisionSchema = z.number().int().min(1);
export const UiLocaleSchema = z.literal("en");
export const ContentLanguageSchema = z.string().min(2).max(64).refine((value) => {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}, "Use a valid language tag, such as en or ru");
export const VisibilitySchema = z.enum(["private", "unlisted", "public"]);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type Id = z.infer<typeof IdSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type UiLocale = z.infer<typeof UiLocaleSchema>;
export type ContentLanguage = z.infer<typeof ContentLanguageSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() }).strict();
}
