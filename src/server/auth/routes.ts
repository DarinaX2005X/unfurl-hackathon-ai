import "server-only";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import {
  PasswordResetRequestSchema, SignInInputSchema, SignUpInputSchema, UpdatePasswordInputSchema, UpdateProfileInputSchema,
} from "../../domain/account";
import { IdSchema } from "../../domain/common";
import { safeReturnTo } from "../../lib/auth-return-to";
import { createRequestAuth } from "./client";
import { isDatabaseConfigured, readAuthConfiguration, requireAccountConfiguration } from "./config";
import { providerFault, ServiceFault } from "./errors";
import { assertSameOrigin, failure, readInput, success } from "./http";
import { accountSession, updateProfile } from "./profile";
import { getVerifiedIdentity, requireVerifiedIdentity } from "./session";

type RequestAuth = ReturnType<typeof createRequestAuth>;
type AuthOperation = "sign-in" | "sign-up" | "forgot-password" | "reset-password" | "sign-out";

function callbackUrl(origin: string, returnTo: unknown): string {
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("returnTo", safeReturnTo(returnTo));
  return callback.toString();
}

export async function handleAuthMutation(request: NextRequest, operation: AuthOperation): Promise<NextResponse> {
  let auth: RequestAuth | undefined;
  try {
    assertSameOrigin(request);
    const config = requireAccountConfiguration();
    auth = createRequestAuth(request, config);
    let response: NextResponse;
    if (operation === "sign-in") {
      const input = await readInput(request, SignInInputSchema);
      const result = await auth.client.auth.signInWithPassword({ email: input.email, password: input.password });
      if (result.error) throw providerFault(result.error);
      const verified = await requireVerifiedIdentity(auth.client);
      response = success({ status: "authenticated", session: await accountSession(verified), redirectTo: safeReturnTo(input.returnTo) });
    } else if (operation === "sign-up") {
      const input = await readInput(request, SignUpInputSchema);
      const result = await auth.client.auth.signUp({
        email: input.email, password: input.password,
        options: {
          emailRedirectTo: callbackUrl(config.origin, input.returnTo),
          ...(input.displayName ? { data: { display_name: input.displayName } } : {}),
        },
      });
      if (result.error) {
        // The response to an already registered email must not enumerate accounts.
        if (!["user_already_exists", "email_exists"].includes(result.error.code ?? "")) throw providerFault(result.error);
      }
      if (result.data.session) {
        const verified = await requireVerifiedIdentity(auth.client);
        response = success({ status: "authenticated", session: await accountSession(verified), redirectTo: safeReturnTo(input.returnTo) });
      } else {
        response = success({ status: "confirmation_required", email: input.email, returnTo: safeReturnTo(input.returnTo) });
      }
    } else if (operation === "forgot-password") {
      const input = await readInput(request, PasswordResetRequestSchema);
      const result = await auth.client.auth.resetPasswordForEmail(input.email, { redirectTo: callbackUrl(config.origin, input.returnTo) });
      if (result.error) throw providerFault(result.error);
      response = success({ status: "recovery_email_requested" });
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
