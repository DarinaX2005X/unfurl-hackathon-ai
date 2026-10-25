import { describe, expect, it, vi } from "vitest";
import { createHttpAccount } from "../../src/application/http-account";

describe("account HTTP boundary", () => {
  it("returns a real confirmation pending result without manufacturing a session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: { status: "confirmation_required", email: "learner@example.com", returnTo: "/library" },
    }));
    const account = createHttpAccount(fetcher);
    const input = { email: "learner@example.com", password: "long password", returnTo: "/library" };
    const result = await account.signUp(input);
    expect(result).toEqual({ ok: true, data: { status: "confirmation_required", email: input.email, returnTo: "/library" } });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify(input) });
  });

  it("does not accept unknown provider payloads as authenticated", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { access_token: "private-token" } }));
    const result = await createHttpAccount(fetcher).signIn({ email: "learner@example.com", password: "password" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("preserves typed API field errors and treats malformed responses as unavailable", async () => {
    const error = { error: { code: "invalid_input", messageKey: "auth.invalidInput", retryable: false, requestId: crypto.randomUUID(), fieldErrors: { email: "auth.emailInvalid" } } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(error, { status: 400 }));
    expect(await createHttpAccount(fetcher).signIn({ email: "bad", password: "password" })).toEqual({ ok: false, error });
  });

  it("rejects a delayed reply after the owner aborts its account scope", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return Response.json({ data: { session: null, capabilities: { generation: false, cloudIdentity: true, cloudPersistence: true } } });
    });
    await expect(createHttpAccount(fetcher).getSession(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
