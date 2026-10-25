import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../src/lib/auth-return-to";

const course = "550e8400-e29b-41d4-a716-446655440000";
const version = "550e8400-e29b-41d4-a716-446655440001";

describe("auth continuation", () => {
  it("preserves the exact course and version through a normalized route", () => {
    const target = `/start/${course}?share=${"a".repeat(43)}&version=${version}`;
    expect(safeReturnTo(target)).toBe(`/start/${course}?version=${version}&share=${"a".repeat(43)}`);
    expect(safeReturnTo(`/chat?conversation=${course}`)).toBe(`/chat?conversation=${course}`);
    expect(safeReturnTo("/explore?q=neural%20networks&contentLanguage=ru")).toBe("/explore?q=neural+networks&contentLanguage=ru");
    expect(safeReturnTo("/courses/learning-ai")).toBe("/courses/learning-ai");
  });

  it.each([
    undefined, null, "", "https://evil.test", "//evil.test/path", "/\\evil.test", "/%2f%2fevil.test",
    "/%252f%252fevil.test", "/account#//evil.test", "/foo/../account", "/%2e%2e/account",
    "/account?next=https://evil.test", "/login", "/signup", "/auth/callback", "/api/auth/sign-out", "/try",
    "/create", "/account?", "/chat?conversation=bad", "/chat?conversation=x&conversation=y",
    `/start/${course}`, `/start/${course}?version=${version}&next=/account`,
    "/explore?q=%0a", "/explore?q=%zz", "/explore?__proto__=x", "/account\n", "/account?x=y",
  ])("falls back safely for unsupported destination %s", (value) => {
    expect(safeReturnTo(value)).toBe(value === "/account?" ? "/account" : "/");
  });

  it("defaults direct login to home and rejects a malformed course/version", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo(`/start/${course}?version=not-an-id`)).toBe("/");
    expect(safeReturnTo("/courses/Uppercase")).toBe("/");
    expect(safeReturnTo(`/s/${"b".repeat(43)}`)).toBe(`/s/${"b".repeat(43)}`);
  });
});
