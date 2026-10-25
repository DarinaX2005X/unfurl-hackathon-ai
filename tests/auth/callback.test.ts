import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), verify: vi.fn(), profile: vi.fn(), identity: vi.fn(), signOut: vi.fn(), apply: vi.fn() }));
vi.mock("../../src/server/auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/auth/client")>();
  return { ...actual, createRequestAuth: () => ({
    client: { auth: { exchangeCodeForSession: mocks.exchange, verifyOtp: mocks.verify, signOut: mocks.signOut } },
    apply: mocks.apply,
  }) };
});
vi.mock("../../src/server/auth/profile", () => ({ accountSession: mocks.profile }));
vi.mock("../../src/server/auth/session", () => ({ requireVerifiedIdentity: mocks.identity }));
import { GET } from "../../src/app/auth/callback/route";

const course = "550e8400-e29b-41d4-a716-446655440000";
const version = "550e8400-e29b-41d4-a716-446655440001";
const target = `/start/${course}?version=${version}`;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/db");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  mocks.exchange.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mocks.verify.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mocks.profile.mockReset().mockResolvedValue({});
  mocks.identity.mockReset().mockResolvedValue({});
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.apply.mockReset().mockImplementation((response) => response);
});
afterEach(() => vi.unstubAllEnvs());

describe("auth callback continuation", () => {
  it("verifies an email link then continues to the exact course version", async () => {
    const response = await GET(new NextRequest(`http://forged-host.test/auth/callback?token_hash=secret&type=email&returnTo=${encodeURIComponent(target)}`));
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ token_hash: "secret", type: "email" });
    expect(response.headers.get("location")).toBe(`http://127.0.0.1:3000${target}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("routes recovery to the password form while preserving the same destination", async () => {
    const response = await GET(new NextRequest(`http://127.0.0.1:3000/auth/callback?token_hash=secret&type=recovery&returnTo=${encodeURIComponent(target)}`));
    const destination = new URL(response.headers.get("location")!);
    expect(destination.pathname).toBe("/reset-password");
    expect(destination.searchParams.get("returnTo")).toBe(target);
  });

  it("rejects mixed callback modes and does not leak tokens in the error redirect", async () => {
    const response = await GET(new NextRequest("http://127.0.0.1:3000/auth/callback?code=private-code&token_hash=private-hash&type=email&returnTo=//evil.test"));
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    const location = response.headers.get("location")!;
    expect(new URL(location).searchParams.get("error")).toBe("expired_link");
    expect(new URL(location).searchParams.get("returnTo")).toBe("/");
    expect(location).not.toMatch(/private-code|private-hash|evil/);
  });

  it("distinguishes storage failure from an expired confirmation link", async () => {
    mocks.profile.mockRejectedValueOnce(new Error("private-database-diagnostic"));
    const response = await GET(new NextRequest("http://127.0.0.1:3000/auth/callback?code=valid-code"));
    const location = response.headers.get("location")!;
    expect(new URL(location).searchParams.get("error")).toBe("service_unavailable");
    expect(location).not.toContain("private-database-diagnostic");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it.each(["code=valid&token_hash=", "code=&token_hash=valid&type=email", "code=valid&type="])("rejects mixed callback parameters even when one is empty: %s", async (query) => {
    const response = await GET(new NextRequest(`http://127.0.0.1:3000/auth/callback?${query}`));
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("expired_link");
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("prevents callback URLs from becoming referrers even without configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const response = await GET(new NextRequest("http://127.0.0.1:3000/auth/callback?code=private-code"));
    expect(response.status).toBe(503);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).not.toContain("private-code");
  });
});
