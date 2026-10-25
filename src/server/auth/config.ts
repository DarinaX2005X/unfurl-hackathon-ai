import "server-only";
import { unavailable } from "./errors";

export interface AuthConfiguration {
  url: string;
  publishableKey: string;
  origin: string;
  secureCookies: boolean;
}

type Environment = Record<string, string | undefined>;

export function readAuthConfiguration(env: Environment = process.env): AuthConfiguration | null {
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const rawOrigin = env.APP_ORIGIN;
  if (!rawUrl || !publishableKey || !rawOrigin) return null;
  try {
    const url = new URL(rawUrl);
    const origin = new URL(rawOrigin);
    const local = ["127.0.0.1", "localhost", "[::1]"];
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local.includes(url.hostname))) throw new Error();
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local.includes(origin.hostname))) throw new Error();
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error();
    return { url: url.origin, publishableKey, origin: origin.origin, secureCookies: origin.protocol === "https:" };
  } catch {
    throw unavailable();
  }
}

export function requireAuthConfiguration(): AuthConfiguration {
  const configuration = readAuthConfiguration();
  if (!configuration) throw unavailable();
  return configuration;
}

export function requireSignupAdminKey(env: Environment = process.env): string {
  const key = env.SUPABASE_SECRET_KEY;
  if (!key) throw unavailable();
  return key;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function requireAccountConfiguration(): AuthConfiguration {
  const configuration = requireAuthConfiguration();
  if (!isDatabaseConfigured()) throw unavailable();
  return configuration;
}
