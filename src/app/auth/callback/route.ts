import { NextResponse, type NextRequest } from "next/server";
import { isAuthError } from "@supabase/supabase-js";
import { safeReturnTo } from "@/lib/auth-return-to";
import { createRequestAuth, privateResponse } from "@/server/auth/client";
import { requireAccountConfiguration } from "@/server/auth/config";
import { failure } from "@/server/auth/http";
import { accountSession } from "@/server/auth/profile";
import { requireVerifiedIdentity } from "@/server/auth/session";
import { ServiceFault, unavailable } from "@/server/auth/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let auth: ReturnType<typeof createRequestAuth> | undefined;
  let origin: string | undefined;
  let unacknowledgedSession = false;
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  try {
    const config = requireAccountConfiguration();
    origin = config.origin;
    auth = createRequestAuth(request, config);
    const params = request.nextUrl.searchParams;
    const code = params.get("code");
    const tokenHash = params.get("token_hash");
    const type = params.get("type");
    const repeated = [...params.keys()].some((key) => params.getAll(key).length !== 1);
    let recovery = false;
    if (repeated || params.has("error") || (params.has("code") && params.has("token_hash"))) throw new ServiceFault(400, "invalid_input", "auth.expiredLink");
    if (code && !params.has("type") && code.length <= 4_096) {
      const result = await auth.client.auth.exchangeCodeForSession(code);
      if (result.error) throw result.error;
      if (!result.data.session) throw unavailable();
      unacknowledgedSession = true;
    } else if (tokenHash && !code && tokenHash.length <= 4_096 && (type === "email" || type === "recovery")) {
      const result = await auth.client.auth.verifyOtp({ token_hash: tokenHash, type });
      if (result.error) throw result.error;
      if (!result.data.session) throw unavailable();
      unacknowledgedSession = true;
      recovery = type === "recovery";
    } else throw new ServiceFault(400, "invalid_input", "auth.expiredLink");
    const verified = await requireVerifiedIdentity(auth.client);
    await accountSession(verified);
    const destination = new URL(recovery ? "/reset-password" : returnTo, origin);
    if (recovery) destination.searchParams.set("returnTo", returnTo);
    const response = auth.apply(NextResponse.redirect(destination, 303));
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    if (!origin) {
      const response = failure(error, request);
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    }
    if (unacknowledgedSession && auth) {
      try { await auth.client.auth.signOut({ scope: "local" }); } catch { /* The browser never receives the new session. */ }
    }
    const destination = new URL("/login", origin);
    const invalidLink = (error instanceof ServiceFault && ["invalid_input", "unauthenticated"].includes(error.code))
      || (isAuthError(error) && error.status !== undefined && error.status < 429);
    destination.searchParams.set("error", invalidLink ? "expired_link" : "service_unavailable");
    destination.searchParams.set("returnTo", returnTo);
    const response = privateResponse(NextResponse.redirect(destination, 303));
    response.headers.set("Referrer-Policy", "no-referrer");
    return auth && !unacknowledgedSession ? auth.apply(response) : response;
  }
}
