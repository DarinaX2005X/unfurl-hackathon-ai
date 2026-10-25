import { NextResponse, type NextRequest } from "next/server";
import { createRequestAuth } from "./server/auth/client";
import { readAuthConfiguration } from "./server/auth/config";

export async function proxy(request: NextRequest) {
  let config;
  try { config = readAuthConfiguration(); } catch { return NextResponse.next({ request }); }
  if (!config) return NextResponse.next({ request });
  const auth = createRequestAuth(request, config);
  // Refresh only. Each private handler still verifies identity and record access.
  try { await auth.client.auth.getClaims(); } catch {
    // An upstream outage must not replace a public page with an invented session.
  }
  return auth.apply(NextResponse.next({ request }));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|docs/|.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2)$).*)"],
};
