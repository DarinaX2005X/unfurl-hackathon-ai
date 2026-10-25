import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  signIn: vi.fn(),
  legacySignUp: vi.fn(),
  resetForEmail: vi.fn(),
  signOut: vi.fn(),
  requireIdentity: vi.fn(),
  getIdentity: vi.fn(),
  profile: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("../../src/server/auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/auth/client")>();
  return {
    ...actual,
    createAdminAuthClient: () => ({ auth: { admin: { createUser: mocks.createUser } } }),
    createRequestAuth: () => ({
      client: { auth: {
        signInWithPassword: mocks.signIn,
        signUp: mocks.legacySignUp,
        resetPasswordForEmail: mocks.resetForEmail,
        signOut: mocks.signOut,
      } },
      apply: mocks.apply,
    }),
  };
});
vi.mock("../../src/server/auth/profile", () => ({ accountSession: mocks.profile }));
vi.mock("../../src/server/runs/composition", () => ({
  getRuntimeCapabilityProjection: async () => ({ generation: false }),
}));
vi.mock("../../src/server/auth/session", () => ({
  requireVerifiedIdentity: mocks.requireIdentity,
  getVerifiedIdentity: mocks.getIdentity,
}));

import { handleAccountState, handleAuthMutation } from "../../src/server/auth/routes";

const actorId = "550e8400-e29b-41d4-a716-446655440000";
const returnTo = `/chat?conversation=${actorId}`;
const session = {
  identity: { id: actorId, email: "learner@example.com", emailConfirmed: true },
  profile: {
    id: actorId,
    displayName: "Learner",
    defaultContentLanguage: null,
    revision: 1,
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
  },
};

function request(operation: "sign-up" | "forgot-password", body: unknown) {
  return new NextRequest(`http://127.0.0.1:3000/api/auth/${operation}`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("SUPABASE_SECRET_KEY", "server-secret");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/db");
  mocks.createUser.mockReset().mockResolvedValue({ data: { user: { id: actorId } }, error: null });
  mocks.signIn.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mocks.legacySignUp.mockReset();
  mocks.resetForEmail.mockReset();
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.requireIdentity.mockReset().mockResolvedValue({ actor: { id: actorId }, identity: session.identity });
  mocks.getIdentity.mockReset().mockResolvedValue({ actor: { id: actorId }, identity: session.identity });
  mocks.profile.mockReset().mockResolvedValue(session);
  mocks.apply.mockReset().mockImplementation((response: NextResponse) => {
    response.cookies.set("sb-session", "opaque");
    return response;
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("signup without email delivery", () => {
  it("auto-confirms on the server, signs in normally and restores the same session on reload", async () => {
    const response = await handleAuthMutation(request("sign-up", {
      email: "learner@example.com",
      password: "a long private password",
      displayName: "Learner",
      returnTo,
    }), "sign-up");

    expect(mocks.createUser).toHaveBeenCalledExactlyOnceWith({
      email: "learner@example.com",
      password: "a long private password",
      email_confirm: true,
      user_metadata: { display_name: "Learner" },
    });
    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith({ email: "learner@example.com", password: "a long private password" });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("sb-session=opaque");
    expect(await response.json()).toEqual({ data: { status: "authenticated", session, redirectTo: returnTo } });

    const reloaded = await handleAccountState(new NextRequest("http://127.0.0.1:3000/api/v1/me", {
      headers: { Cookie: "sb-session=opaque" },
    }));
    expect(await reloaded.json()).toEqual({ data: {
      session,
      capabilities: { generation: false, cloudIdentity: true, cloudPersistence: true },
    } });
  });

  it.each([
    { code: "email_exists", status: 422 },
    { code: "unexpected_failure" },
  ])("recovers a duplicate or lost create response only by authenticating the supplied password", async (creationError) => {
    mocks.createUser.mockResolvedValueOnce({ data: { user: null }, error: creationError });
    const response = await handleAuthMutation(request("sign-up", {
      email: "learner@example.com", password: "a long private password", returnTo,
    }), "sign-up");
    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith({ email: "learner@example.com", password: "a long private password" });
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("authenticated");
  });

  it("does not take over a duplicate account when the supplied password is wrong", async () => {
    mocks.createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: "email_exists", status: 422 } });
    mocks.signIn.mockResolvedValueOnce({ data: { session: null }, error: { code: "invalid_credentials", status: 400 } });
    const response = await handleAuthMutation(request("sign-up", {
      email: "learner@example.com", password: "wrong but long password", returnTo,
    }), "sign-up");
    expect(response.status).toBe(401);
    expect((await response.json()).error.messageKey).toBe("auth.invalidCredentials");
    expect(mocks.requireIdentity).not.toHaveBeenCalled();
  });

  it("sanitizes returnTo and never invokes signup or recovery email APIs", async () => {
    const signup = await handleAuthMutation(request("sign-up", {
      email: "learner@example.com", password: "a long private password", returnTo: "//evil.example/path",
    }), "sign-up");
    expect((await signup.json()).data.redirectTo).toBe("/");

    const recovery = await handleAuthMutation(request("forgot-password", {
      email: "learner@example.com", returnTo,
    }), "forgot-password");
    expect(recovery.status).toBe(404);
    expect((await recovery.json()).error.messageKey).toBe("auth.passwordRecoveryUnavailable");
    expect(mocks.legacySignUp).not.toHaveBeenCalled();
    expect(mocks.resetForEmail).not.toHaveBeenCalled();
  });
});
