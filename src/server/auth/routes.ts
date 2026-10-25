import "server-only";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import {
  SignInInputSchema, SignUpInputSchema, UpdatePasswordInputSchema, UpdateProfileInputSchema,
} from "../../domain/account";
import { IdSchema } from "../../domain/common";
import { safeReturnTo } from "../../lib/auth-return-to";
import { createAdminAuthClient, createRequestAuth } from "./client";
import { isDatabaseConfigured, readAuthConfiguration, requireAccountConfiguration } from "./config";
import { providerFault, ServiceFault, unavailable } from "./errors";
import { assertSameOrigin, failure, readInput, success } from "./http";
import { accountSession, updateProfile } from "./profile";
import { getVerifiedIdentity, requireVerifiedIdentity } from "./session";

type RequestAuth = ReturnType<typeof createRequestAuth>;
type AuthOperation = "sign-in" | "sign-up" | "forgot-password" | "reset-password" | "sign-out";

export async function handleAuthMutation(request: NextRequest, operation: AuthOperation): Promise<NextResponse> {
  let auth: RequestAuth | undefined;
  let unacknowledgedSession = false;
  try {
    assertSameOrigin(request);
    const config = requireAccountConfiguration();
    auth = createRequestAuth(request, config);
    let response: NextResponse;
    if (operation === "sign-in") {
      const input = await readInput(request, SignInInputSchema);
      const result = await auth.client.auth.signInWithPassword({ email: input.email, password: input.password });
      if (result.error) throw providerFault(result.error);
      if (!result.data.session) throw unavailable();
      unacknowledgedSession = true;
      const verified = await requireVerifiedIdentity(auth.client);
      response = success({ status: "authenticated", session: await accountSession(verified), redirectTo: safeReturnTo(input.returnTo) });
    } else if (operation === "sign-up") {
      const input = await readInput(request, SignUpInputSchema);
      const created = await createAdminAuthClient(config).auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        ...(input.displayName ? { user_metadata: { display_name: input.displayName } } : {}),
      });
      // A retry after a duplicate or an ambiguous lost create response is safe only
      // when the supplied password can authenticate that account. Never mutate an
      // existing user to make registration appear successful.
      const result = await auth.client.auth.signInWithPassword({ email: input.email, password: input.password });
      if (result.error || !result.data.session) {
        const duplicate = ["user_already_exists", "email_exists"].includes(created.error?.code ?? "");
        if (created.error && !duplicate) throw providerFault(created.error);
        if (result.error) throw providerFault(result.error);
        throw unavailable();
      }
      unacknowledgedSession = true;
      const verified = await requireVerifiedIdentity(auth.client);
      response = success({ status: "authenticated", session: await accountSession(verified), redirectTo: safeReturnTo(input.returnTo) });
    } else if (operation === "forgot-password") {
      throw new ServiceFault(404, "not_found", "auth.passwordRecoveryUnavailable");
    } else if (operation === "reset-password") {
      const input = await readInput(request, UpdatePasswordInputSchema);
      await requireVerifiedIdentity(auth.client);
      const result = await auth.client.auth.updateUser({ password: input.password });
      if (result.error) throw providerFault(result.error);
      response = success({ status: "password_updated", redirectTo: safeReturnTo(input.returnTo) });
    } else {
      await readInput(request, z.object({}).strict());
      const result = await auth.client.auth.signOut({ scope: "local" });
      if (result.error) throw providerFault(result.error);
      response = success({ status: "signed_out", redirectTo: "/" });
    }
    return auth.apply(response);
  } catch (error) {
    const response = failure(error, request);
    if (unacknowledgedSession && auth) {
      // Do not switch the browser's actor when its durable account load failed.
      // Revoke only the new provider session; do not forward its cookie removals
      // over the browser's previous, still-valid session.
      try { await auth.client.auth.signOut({ scope: "local" }); } catch { /* Best effort; no new token is exposed. */ }
      return response;
    }
    return auth ? auth.apply(response) : response;
  }
}

export async function handleAccountState(request: NextRequest): Promise<NextResponse> {
  let auth: RequestAuth | undefined;
  try {
    const config = readAuthConfiguration();
    const cloudPersistence = Boolean(config && isDatabaseConfigured());
    if (!config || !cloudPersistence) return success({ session: null, capabilities: { generation: false, cloudIdentity: false, cloudPersistence: false } });
    auth = createRequestAuth(request, config);
    const verified = await getVerifiedIdentity(auth.client);
    const session = verified ? await accountSession(verified) : null;
    return auth.apply(success({ session, capabilities: { generation: false, cloudIdentity: true, cloudPersistence } }));
  } catch (error) {
    const response = failure(error, request);
    return auth ? auth.apply(response) : response;
  }
}

export async function handleProfileUpdate(request: NextRequest): Promise<NextResponse> {
  let auth: RequestAuth | undefined;
  try {
    assertSameOrigin(request);
    const config = requireAccountConfiguration();
    const input = await readInput(request, UpdateProfileInputSchema);
    const key = IdSchema.safeParse(request.headers.get("idempotency-key"));
    if (!key.success) throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
    auth = createRequestAuth(request, config);
    const verified = await requireVerifiedIdentity(auth.client);
    return auth.apply(success(await updateProfile(verified.actor, input, key.data)));
  } catch (error) {
    const response = failure(error, request);
    return auth ? auth.apply(response) : response;
  }
}
