import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { getVerifiedIdentity } from "../../src/server/auth/session";

const userId = "550e8400-e29b-41d4-a716-446655440000";
const sessionId = "550e8400-e29b-41d4-a716-446655440001";

function client(sub: string, session: unknown = sessionId) {
  const getUser = vi.fn(async () => ({ data: { user: {
    id: userId, email: "learner@example.com", email_confirmed_at: "2026-10-25T00:00:00Z", user_metadata: { display_name: "Learner", role: "admin" },
  } }, error: null }));
  const getClaims = vi.fn(async () => ({ data: { claims: { sub, session_id: session } }, error: null }));
  const getSession = vi.fn();
  return { provider: { auth: { getUser, getClaims, getSession } } as unknown as SupabaseClient, getUser, getClaims, getSession };
}

describe("verified server actor", () => {
  it("requires a current provider user and matching verified claims", async () => {
    const provider = client(userId);
    expect(await getVerifiedIdentity(provider.provider)).toEqual({
      actor: { id: userId, sessionId, email: "learner@example.com" },
      identity: { id: userId, email: "learner@example.com", emailConfirmed: true }, initialDisplayName: "Learner",
    });
    expect(provider.getUser).toHaveBeenCalledOnce();
    expect(provider.getClaims).toHaveBeenCalledOnce();
    expect(provider.getSession).not.toHaveBeenCalled();
  });

  it("rejects mismatched identities and absent session claims", async () => {
    expect(await getVerifiedIdentity(client(sessionId).provider)).toBeNull();
    expect(await getVerifiedIdentity(client(userId, null).provider)).toBeNull();
    expect(await getVerifiedIdentity(client(userId, "forged-session").provider)).toBeNull();
  });
});
