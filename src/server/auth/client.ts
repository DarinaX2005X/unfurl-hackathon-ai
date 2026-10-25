import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthConfiguration, type AuthConfiguration } from "./config";

export const PRIVATE_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

export function privateResponse<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PRIVATE_CACHE_HEADERS)) response.headers.set(name, value);
  response.headers.set("Vary", "Cookie");
  return response;
}

function cookieOptions(config: AuthConfiguration): CookieOptions {
  // Authentication is server-mediated. No browser Supabase client reads these cookies.
  return { path: "/", sameSite: "lax", secure: config.secureCookies, httpOnly: true };
}

const authFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  cache: "no-store",
  signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
});

export function createRequestAuth(request: NextRequest, config = requireAuthConfiguration()) {
  const pending = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const cacheHeaders = new Headers(PRIVATE_CACHE_HEADERS);
  const client = createServerClient(config.url, config.publishableKey, {
    cookieOptions: cookieOptions(config),
    global: { fetch: authFetch },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (updates, headers) => {
        for (const item of updates) {
          request.cookies.set(item.name, item.value);
          pending.set(item.name, item);
        }
        for (const [name, value] of Object.entries(headers)) cacheHeaders.set(name, value);
      },
    },
  });
  return {
    client,
    apply<T extends NextResponse>(response: T): T {
      privateResponse(response);
      for (const item of pending.values()) response.cookies.set(item.name, item.value, item.options);
      cacheHeaders.forEach((value, name) => response.headers.set(name, value));
      return response;
    },
  };
}

export async function createServerAuthClient() {
  const config = requireAuthConfiguration();
  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookieOptions: cookieOptions(config),
    global: { fetch: authFetch },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (updates) => {
        try {
          for (const item of updates) cookieStore.set(item.name, item.value, item.options);
        } catch {
          // A Server Component is read-only; proxy refreshes its request cookies first.
        }
      },
    },
  });
}
