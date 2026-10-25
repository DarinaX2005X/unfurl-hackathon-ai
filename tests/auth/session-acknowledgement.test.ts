import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), createUser: vi.fn(), signOut: vi.fn(), profile: vi.fn(), identity: vi.fn(), apply: vi.fn() }));
vi.mock("../../src/server/auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/auth/client")>();
  return {
    ...actual,
    createAdminAuthClient: () => ({ auth: { admin: { createUser: mocks.createUser } } }),
    createRequestAuth: () => ({
      client: { auth: { signInWithPassword: mocks.signIn, signOut: mocks.signOut } },
      apply: mocks.apply,
    }),
  };
});
vi.mock("../../src/server/auth/profile", () => ({ accountSession: mocks.profile }));
vi.mock("../../src/server/auth/session", () => ({ requireVerifiedIdentity: mocks.identity }));
import { handleAuthMutation } from "../../src/server/auth/routes";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/db");
  mocks.signIn.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mocks.createUser.mockReset().mockResolvedValue({ data: { user: {} }, error: null });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.identity.mockReset().mockResolvedValue({});
  mocks.profile.mockReset().mockRejectedValue(new Error("storage unavailable"));
  mocks.apply.mockReset().mockImplementation((response: NextResponse) => {
    response.cookies.set("new-account", "unacknowledged-session");
    return response;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("account change acknowledgement", () => {
  it.each(["sign-in", "sign-up"] as const)("does not change cookies when %s succeeds at the provider but fails to load durable account data", async (operation) => {
    const request = new NextRequest(`http://127.0.0.1:3000/api/auth/${operation}`, {
      method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", Cookie: "existing-account=previous-session" },
      body: JSON.stringify({ email: "learner@example.com", password: "long-enough-password" }),
    });
    const response = await handleAuthMutation(request, operation);
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it("does not expose the new session if best-effort provider revocation also fails", async () => {
    mocks.signOut.mockRejectedValueOnce(new Error("provider offline"));
    const request = new NextRequest("http://127.0.0.1:3000/api/auth/sign-in", {
      method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "learner@example.com", password: "long-enough-password" }),
    });
    const response = await handleAuthMutation(request, "sign-in");
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
