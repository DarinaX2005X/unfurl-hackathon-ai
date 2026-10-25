import "server-only";
import { isAuthError, type SupabaseClient } from "@supabase/supabase-js";
import { AccountIdentitySchema, type AccountIdentity } from "../../domain/account";
import { IdSchema } from "../../domain/common";
import type { Actor } from "./actor";
import { createServerAuthClient } from "./client";
import { readAuthConfiguration } from "./config";
import { ServiceFault, unavailable } from "./errors";

export type { Actor } from "./actor";

export interface VerifiedIdentity {
  actor: Actor;
  identity: AccountIdentity;
  initialDisplayName: string | null;
}

function isAbsentSession(error: unknown): boolean {
  if (!isAuthError(error)) return false;
  return error.name === "AuthSessionMissingError" || [
    "bad_jwt", "session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "user_not_found",
  ].includes(error.code ?? "") || error.status === 401;
}

export async function getVerifiedIdentity(client?: SupabaseClient): Promise<VerifiedIdentity | null> {
  if (!client && !readAuthConfiguration()) return null;
  const auth = client ?? await createServerAuthClient();
  const userResult = await auth.auth.getUser();
  if (userResult.error) {
    if (isAbsentSession(userResult.error)) return null;
    throw unavailable();
  }
  if (!userResult.data.user) return null;
  const claimsResult = await auth.auth.getClaims();
  if (claimsResult.error) {
    if (isAbsentSession(claimsResult.error)) return null;
    throw unavailable();
  }
  const claims = claimsResult.data?.claims;
  const user = userResult.data.user;
  const sessionId = IdSchema.safeParse(claims?.session_id);
  if (claims?.sub !== user.id || !IdSchema.safeParse(user.id).success || !sessionId.success) return null;
  const identity = AccountIdentitySchema.parse({ id: user.id, email: user.email ?? null, emailConfirmed: Boolean(user.email_confirmed_at) });
  const name: unknown = user.user_metadata?.display_name;
  const initialDisplayName = typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 80 ? name.trim() : null;
  return { actor: { id: identity.id, sessionId: sessionId.data, email: identity.email }, identity, initialDisplayName };
}

export async function requireVerifiedIdentity(client?: SupabaseClient): Promise<VerifiedIdentity> {
  const verified = await getVerifiedIdentity(client);
  if (!verified) throw new ServiceFault(401, "unauthenticated", "auth.signInRequired");
  return verified;
}

export async function getActor(): Promise<Actor | null> {
  return (await getVerifiedIdentity())?.actor ?? null;
}

export async function requireActor(): Promise<Actor> {
  return (await requireVerifiedIdentity()).actor;
}
