import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cursorFilters, decodeCursor, encodeCursor } from "../../src/server/catalog/cursor";

describe("catalog keyset cursors", () => {
  it("round-trips only with the same collection and filters", () => {
    const filters = cursorFilters({ q: "model", contentLanguage: "en" });
    const value = { kind: "catalog-v1" as const, sortAt: "2026-10-25T00:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000001", filters };
    const encoded = encodeCursor(value);
    expect(decodeCursor(encoded, "catalog-v1", filters)).toEqual(value);
    expect(() => decodeCursor(encoded, "library-v1", filters)).toThrow("catalog.invalidCursor");
    expect(() => decodeCursor(encoded, "catalog-v1", cursorFilters({ q: "changed" }))).toThrow("catalog.invalidCursor");
  });
  it("rejects malformed and noncanonical encodings", () => {
    expect(() => decodeCursor("not-json", "catalog-v1", cursorFilters({}))).toThrow("catalog.invalidCursor");
  });
});
