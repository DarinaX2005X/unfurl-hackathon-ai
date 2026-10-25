import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LoginRoute from "../../src/app/login/page";
import SignupRoute from "../../src/app/signup/page";
import ForgotPasswordRoute from "../../src/app/forgot-password/page";
import ResetPasswordRoute from "../../src/app/reset-password/page";
import { authRouteInput } from "../../src/features/account/auth-route";
import { routes } from "../../src/lib/routes";

const destination = "/chat?conversation=9bb93c5a-5095-458e-a701-d69363c4dad3";

describe("mounted account route contract", () => {
  it("renders useful sign-in fields and keeps the initial conversation in both alternate journeys", async () => {
    const html = renderToStaticMarkup(await LoginRoute({ searchParams: Promise.resolve({ returnTo: destination }) }));
    expect(html).toContain('name="email"');
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain(`href="${routes.signup(destination)}"`);
    expect(html).not.toContain("Forgot password?");
    expect(html).toContain("After signing in, you will return to your conversation.");
  });

  it("offers confirmation only for a new password and keeps reset links inside the current journey", async () => {
    const signup = renderToStaticMarkup(await SignupRoute({ searchParams: Promise.resolve({ returnTo: destination }) }));
    const recovery = renderToStaticMarkup(await ForgotPasswordRoute({ searchParams: Promise.resolve({ returnTo: destination }) }));
    const reset = renderToStaticMarkup(await ResetPasswordRoute({ searchParams: Promise.resolve({ returnTo: destination }) }));
    expect(signup).toContain('name="confirmPassword"');
    expect(signup).toMatch(/autocomplete="new-password"/i);
    expect(recovery).not.toContain('name="password"');
    expect(recovery).not.toContain('name="email"');
    expect(recovery).toContain("Email recovery is not available.");
    expect(recovery).toContain(`href="${routes.login(destination)}"`);
    expect(reset).toContain('name="confirmPassword"');
    expect(reset).not.toContain('name="email"');
  });

  it("treats a duplicated or external destination as direct sign-in and renders no untrusted callback message", async () => {
    expect(authRouteInput({ returnTo: [destination, "https://evil.example"] }).returnTo).toBe("/");
    const html = renderToStaticMarkup(await LoginRoute({ searchParams: Promise.resolve({ returnTo: "//evil.example", error: "<script>secret</script>" }) }));
    expect(html).toContain('href="/signup"');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("secret");
  });

  it("keeps the safe continuation when an email link expires", async () => {
    const html = renderToStaticMarkup(await LoginRoute({ searchParams: Promise.resolve({ returnTo: destination, error: "expired_link" }) }));
    expect(html).toContain("This link has expired or was already used.");
    expect(html).not.toContain("request a new password link");
  });

  it("distinguishes an unavailable account callback from an expired email link", async () => {
    const html = renderToStaticMarkup(await LoginRoute({ searchParams: Promise.resolve({ returnTo: destination, error: "service_unavailable" }) }));
    expect(html).toContain("Try again, or sign in below.");
    expect(html).not.toContain("This link has expired");
    expect(html).toContain(`href="${routes.signup(destination)}"`);
  });
});
