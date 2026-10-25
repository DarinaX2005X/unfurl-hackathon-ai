import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
import { assertSameOrigin, readInput } from "../../src/server/auth/http";
import { readAuthConfiguration } from "../../src/server/auth/config";
import { handleAccountState, handleAuthMutation } from "../../src/server/auth/routes";

afterEach(() => vi.unstubAllEnvs());

function configured() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
}

describe("server auth trust boundary", () => {
  it("keeps disabled capabilities truthful without inventing a session", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("DATABASE_URL", "");
    const response = await handleAccountState(new NextRequest("http://127.0.0.1:3000/api/v1/me"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ data: { session: null, capabilities: { generation: false, cloudIdentity: false, cloudPersistence: false } } });
    const mutation = await handleAuthMutation(new NextRequest("http://127.0.0.1:3000/api/auth/sign-in", {
      method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: "{}",
    }), "sign-in");
    expect(mutation.status).toBe(503);
    expect((await mutation.json()).error.code).toBe("service_unavailable");
  });

  it("requires the configured origin and a JSON mutation, regardless of Host", () => {
    configured();
    expect(() => assertSameOrigin(new Request("http://forged.test/", { headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" } }))).not.toThrow();
    for (const headers of [
      { Origin: "https://evil.test", "Content-Type": "application/json" },
      { "Content-Type": "application/json" },
      { Origin: "http://127.0.0.1:3000", "Content-Type": "text/plain" },
      { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    ]) expect(() => assertSameOrigin(new Request("http://127.0.0.1:3000/", { headers }))).toThrow();
  });

  it("rejects unexpected config origins without returning configuration secrets", () => {
    expect(() => readAuthConfiguration({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "do-not-return-this", APP_ORIGIN: "http://public.example.com" })).toThrow("auth.unavailable");
    expect(readAuthConfiguration({})).toBeNull();
  });

  it("bounds UTF-8 bodies while allowing an explicit larger composer limit", async () => {
    const body = JSON.stringify({ text: "界".repeat(8_000) });
    const request = () => new Request("http://127.0.0.1:3000/", { method: "POST", body });
    await expect(readInput(request(), z.object({ text: z.string() }))).rejects.toMatchObject({ status: 400 });
    await expect(readInput(request(), z.object({ text: z.string() }), { maxBytes: 100_000 })).resolves.toEqual({ text: "界".repeat(8_000) });
  });
});
