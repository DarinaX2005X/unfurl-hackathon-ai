"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { httpAccount } from "@/application/http-account";
import { Button, LinkButton, Notice, TextField } from "@/components/ui";
import { safeReturnTo } from "@/lib/auth-return-to";
import { routes } from "@/lib/routes";
import { accountErrorMessage, accountServerFields, authContinuationText, submitAuthForm, validateAuthForm,
  type AccountFieldErrors, type AuthMode, type AuthValues } from "./account-form";
import { accountScope } from "./account-scope";
import { finishAccountChange, refreshAccount, useAccountSession } from "./account-session";
import { AuthLayout } from "./AuthLayout";
import { PasswordField } from "./PasswordField";
import type { AuthCallbackError } from "./auth-route";

const titles: Record<AuthMode, string> = { login: "Sign in", signup: "Create your account", "forgot-password": "Reset your password", "reset-password": "Choose a new password" };
const actions: Record<AuthMode, [string, string]> = { login: ["Sign in", "Signing in"], signup: ["Create account", "Creating account"], "forgot-password": ["Send reset link", "Requesting reset link"], "reset-password": ["Save new password", "Saving password"] };
const emptyValues: AuthValues = { email: "", password: "", confirmPassword: "", displayName: "" };

function focusField(form: HTMLFormElement | null, fields: AccountFieldErrors) {
  const first = ["displayName", "email", "password", "confirmPassword"].find((field) => fields[field as keyof AccountFieldErrors]);
  const input = first ? form?.elements.namedItem(first) : null;
  if (input instanceof HTMLElement) input.focus();
}

export function AuthScreen({ mode, returnTo = "/", callbackError = null }: { mode: AuthMode; returnTo?: string; callbackError?: AuthCallbackError }) {
  const destination = safeReturnTo(returnTo);
  const account = useAccountSession();
  const [values, setValues] = useState(emptyValues);
  const [fields, setFields] = useState<AccountFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const requestRef = useRef<ReturnType<typeof accountScope.request> | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);

  const newPassword = mode === "signup" || mode === "reset-password";
  const unavailable = account.status === "ready" && !account.capabilities.cloudIdentity;
  const resolvingSession = account.status === "loading" && (mode === "login" || mode === "signup");
  const missingRecovery = mode === "reset-password" && account.status === "ready" && account.capabilities.cloudIdentity && !account.session;
  const signedIn = account.status === "ready" && account.session && (mode === "login" || mode === "signup");

  function change(field: keyof AuthValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFields((current) => { const next = { ...current }; delete next[field]; return next; });
    setError(null);
  }
  function blur(field: keyof AuthValues) {
    const message = validateAuthForm(mode, values)[field];
    setFields((current) => { const next = { ...current }; if (message) next[field] = message; else delete next[field]; return next; });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current || resolvingSession) return;
    const invalid = validateAuthForm(mode, values);
    setFields(invalid);
    setError(null);
    if (Object.keys(invalid).length) { focusField(formRef.current, invalid); return; }
    const request = accountScope.request(accountScope.actorId);
    requestRef.current = request;
    setPending(true);
    try {
      const result = await submitAuthForm(httpAccount, mode, values, destination, request.signal);
      if (!request.isCurrent()) return;
      if (result.kind === "invalid") { setFields(result.fields); focusField(formRef.current, result.fields); }
      else if (result.kind === "failed") {
        const serverFields = accountServerFields(result.error, mode);
        setFields(serverFields);
        setError(accountErrorMessage(result.error));
        focusField(formRef.current, serverFields);
      } else if (result.result.status === "authenticated" || result.result.status === "password_updated") {
        finishAccountChange(result.result.redirectTo);
      }
    } catch {
      if (!request.signal.aborted) setError("We could not reach the account service. Your entries are still here. Please try again.");
    } finally {
      request.release();
      if (requestRef.current === request) { requestRef.current = null; setPending(false); }
    }
  }

  const description = mode === "forgot-password" ? undefined
    : mode === "reset-password" ? "Choose a password you have not used for this account before."
      : authContinuationText(destination);

  return <AuthLayout title={mode === "forgot-password" ? "Password reset is unavailable" : titles[mode]} {...(description ? { description } : {})}>
    {signedIn ? <div className="uf-account-stack">
      <p>You are signed in{account.session?.identity.email ? <> as <strong>{account.session.identity.email}</strong></> : ""}.</p>
      <LinkButton href={destination}>Continue</LinkButton>
      <Link className="uf-text-link" href={routes.account}>Open your account</Link>
    </div> : mode === "forgot-password" ? <div className="uf-account-stack">
      <Notice tone="warning">Email recovery is not available. If you are signed in, you can change your password from your account.</Notice>
      <LinkButton href={account.status === "ready" && account.session ? routes.resetPassword(destination) : routes.login(destination)}>
        {account.status === "ready" && account.session ? "Change password" : "Back to sign in"}
      </LinkButton>
    </div> : missingRecovery ? <div className="uf-account-stack">
      <Notice tone="warning">Sign in before changing your password.</Notice>
      <LinkButton href={routes.login(destination)}>Back to sign in</LinkButton>
    </div> : <>
      {callbackError === "expired_link" && <Notice tone="warning" className="uf-account-feedback">This link has expired or was already used. Sign in below to continue.</Notice>}
      {(callbackError === "service_unavailable" || unavailable || account.status === "error") && <Notice tone="warning" className="uf-account-feedback"
        action={<Button variant="secondary" size="compact" onClick={() => void refreshAccount()}>Try again</Button>}>{callbackError === "service_unavailable"
          ? "Account access is temporarily unavailable. Try again, or sign in below."
          : "Account access is temporarily unavailable. Please try again."}</Notice>}
      <form className="uf-account-form" ref={formRef} onSubmit={submit} noValidate aria-busy={pending}>
        {mode === "signup" && <TextField id="account-name" name="displayName" label="Display name (optional)" autoComplete="nickname"
          value={values.displayName} maxLength={80} readOnly={pending} onChange={(event) => change("displayName", event.target.value)} onBlur={() => blur("displayName")}
          {...(fields.displayName ? { error: fields.displayName } : {})} />}
        {mode !== "reset-password" && <TextField id="account-email" name="email" label="Email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
          value={values.email} maxLength={254} required readOnly={pending} onChange={(event) => change("email", event.target.value)} onBlur={() => blur("email")}
          {...(fields.email ? { error: fields.email } : {})} />}
        <PasswordField id="account-password" name="password" label={mode === "reset-password" ? "New password" : "Password"}
          autoComplete={newPassword ? "new-password" : "current-password"} value={values.password} maxLength={128} required readOnly={pending}
          onChange={(event) => change("password", event.target.value)} onBlur={() => blur("password")}
          {...(newPassword && !fields.password ? { hint: "Use 12 to 128 characters. Spaces are allowed." } : {})} {...(fields.password ? { error: fields.password } : {})} />
        {newPassword && <PasswordField id="account-confirm-password" name="confirmPassword" label="Confirm password" autoComplete="new-password"
          value={values.confirmPassword} maxLength={128} required readOnly={pending} onChange={(event) => change("confirmPassword", event.target.value)} onBlur={() => blur("confirmPassword")}
          {...(fields.confirmPassword ? { error: fields.confirmPassword } : {})} />}
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" className="uf-account-form__submit" pending={pending} disabled={unavailable || resolvingSession || (mode === "reset-password" && account.status === "loading")}>
          {pending ? actions[mode][1] : actions[mode][0]}
        </Button>
      </form>
      <div className="uf-account-switch">
        {mode === "login" ? <><span>New to Unfurl?</span><Link className="uf-text-link" href={routes.signup(destination)}>Create an account</Link></>
          : mode === "signup" ? <><span>Already have an account?</span><Link className="uf-text-link" href={routes.login(destination)}>Sign in</Link></>
            : <Link className="uf-text-link" href={routes.login(destination)}>Back to sign in</Link>}
      </div>
    </>}
  </AuthLayout>;
}
