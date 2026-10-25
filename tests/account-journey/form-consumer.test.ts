import { describe, expect, it, vi } from "vitest";
import { createHttpAccount } from "../../src/application/http-account";
import { accountServerFields, submitAuthForm, type AuthValues } from "../../src/features/account/account-form";
import { routes } from "../../src/lib/routes";

const courseId = "c7f19b2d-f745-4a72-97e4-7166ef59db53";
const versionId = "51b47f49-9d2f-477b-a727-6b5214ccf748";
const actorId = "8cbf70c9-c0e9-4da3-92bf-e254c9e6dab5";
const returnTo = `/start/${courseId}?version=${versionId}&share=${"a".repeat(43)}`;
const values: AuthValues = { email: "  learner@example.com  ", password: "  twelve spaces matter  ", confirmPassword: "  twelve spaces matter  ", displayName: "  Learning person  " };
const session = {
  identity: { id: actorId, email: "learner@example.com", emailConfirmed: true },
  profile: { id: actorId, displayName: "Learning person", defaultContentLanguage: null, revision: 1, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" },
};

function transport(data: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
}

describe("account forms through the HTTP account consumer", () => {
  it("sends one registration with exact password and course continuation while keeping confirmation client-only", async () => {
    const fetcher = transport({ data: { status: "confirmation_required", email: "learner@example.com", returnTo } });
    const result = await submitAuthForm(createHttpAccount(fetcher), "signup", values, returnTo, new AbortController().signal);
    expect(result).toEqual({ kind: "complete", result: { status: "confirmation_required", email: "learner@example.com", returnTo } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-up");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(init!.body as string)).toEqual({ email: "learner@example.com", password: values.password, displayName: "Learning person", returnTo });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("result.session");
  });

  it("keeps a short existing password valid for sign-in and defaults direct entry to the homepage", async () => {
    const fetcher = transport({ data: { status: "authenticated", session, redirectTo: "/" } });
    const result = await submitAuthForm(createHttpAccount(fetcher), "login", { ...values, password: " x " }, "https://evil.example/", new AbortController().signal);
    expect(result.kind).toBe("complete");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ password: " x ", returnTo: "/" });
  });

  it("blocks a mismatching confirmation before any request and preserves the entered object", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const entered = { ...values, confirmPassword: "different password" };
    const result = await submitAuthForm(createHttpAccount(fetcher), "signup", entered, returnTo, new AbortController().signal);
    expect(result).toEqual({ kind: "invalid", fields: { confirmPassword: "The passwords do not match." } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(entered.password).toBe(values.password);
    expect(entered.email).toBe(values.email);
  });

  it("carries the exact course through login, signup, recovery links and password update", async () => {
    let destination = returnTo;
    for (const link of [routes.login, routes.signup, routes.forgotPassword, routes.login]) {
      destination = new URL(link(destination), "https://unfurl.example").searchParams.get("returnTo")!;
      expect(destination).toBe(returnTo);
    }
    const resetRequest = transport({ data: { status: "recovery_email_requested" } });
    await submitAuthForm(createHttpAccount(resetRequest), "forgot-password", values, destination, new AbortController().signal);
    expect(JSON.parse(resetRequest.mock.calls[0]![1]!.body as string)).toEqual({ email: "learner@example.com", returnTo });
    const passwordRequest = transport({ data: { status: "password_updated", redirectTo: returnTo } });
    await submitAuthForm(createHttpAccount(passwordRequest), "reset-password", values, destination, new AbortController().signal);
    expect(JSON.parse(passwordRequest.mock.calls[0]![1]!.body as string)).toEqual({ password: values.password, returnTo });
  });

  it("does not convert service failure into a local session or consume entered credentials", async () => {
    const failure = { error: { code: "service_unavailable", messageKey: "auth.unavailable", retryable: true, requestId: actorId } };
    const fetcher = transport(failure, 503);
    const result = await submitAuthForm(createHttpAccount(fetcher), "login", values, returnTo, new AbortController().signal);
    expect(result).toEqual({ kind: "failed", error: failure });
    expect(values.password).toBe("  twelve spaces matter  ");
  });

  it("explains a provider password rejection without leaking an arbitrary server message", () => {
    const fields = accountServerFields({ error: { code: "invalid_input", messageKey: "auth.invalidInput", retryable: false, requestId: actorId,
      fieldErrors: { password: "auth.passwordUnchanged", email: "private provider diagnostic" } } }, "reset-password");
    expect(fields.password).toBe("Choose a password you have not used for this account before.");
    expect(fields.email).toBe("Enter a valid email address.");
  });

  it("rejects an aborted response even when the network ignores cancellation", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const controller = new AbortController();
    const result = submitAuthForm(createHttpAccount(fetcher), "login", values, returnTo, controller.signal);
    controller.abort();
    resolve(new Response(JSON.stringify({ data: { status: "authenticated", session, redirectTo: returnTo } })));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
