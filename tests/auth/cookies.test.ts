import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { CookieMethodsServer, CookieOptions } from "@supabase/ssr";
vi.mock("server-only", () => ({}));
const factory = vi.hoisted(() => vi.fn());
vi.mock("@supabase/ssr", () => ({ createServerClient: factory }));
import { createRequestAuth } from "../../src/server/auth/client";

describe("SSR auth cookie response", () => {
  it("keeps refreshed cookies and SDK cache headers when returning a new redirect", async () => {
    factory.mockReturnValue({ auth: {} });
    const request = new NextRequest("https://unfurl.example/auth/callback");
    const context = createRequestAuth(request, { url: "https://example.supabase.co", publishableKey: "test-key", origin: "https://unfurl.example", secureCookies: true });
    const options = factory.mock.calls.at(-1)?.[2] as { cookieOptions: CookieOptions; cookies: CookieMethodsServer };
    expect(options.cookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    await options.cookies.setAll!([{ name: "sb-auth-token", value: "secret", options: options.cookieOptions }], {
      "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Expires: "0", Pragma: "no-cache",
    });
    const response = context.apply(NextResponse.redirect("https://unfurl.example/library"));
    expect(response.cookies.get("sb-auth-token")?.value).toBe("secret");
    expect(request.cookies.get("sb-auth-token")?.value).toBe("secret");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
  });
});
