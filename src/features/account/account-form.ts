import type { AccountPort } from "@/application/account-port";
import {
  PasswordResetRequestSchema, SignInInputSchema, SignUpInputSchema, UpdatePasswordInputSchema,
  type AuthenticatedResult, type PasswordResetRequested, type PasswordUpdated, type SignUpResult,
} from "@/domain/account";
import type { ApiError } from "@/domain/errors";
import type { ServiceResult } from "@/application/ports";
import { safeReturnTo } from "@/lib/auth-return-to";

export type AuthMode = "login" | "signup" | "forgot-password" | "reset-password";
export interface AuthValues { email: string; password: string; confirmPassword: string; displayName: string }
export type AccountField = keyof AuthValues | "defaultContentLanguage";
export type AccountFieldErrors = Partial<Record<AccountField, string>>;
type AuthResult = AuthenticatedResult | SignUpResult | PasswordResetRequested | PasswordUpdated;
export type AuthSubmission =
  | { kind: "invalid"; fields: AccountFieldErrors }
  | { kind: "failed"; error: ApiError }
  | { kind: "complete"; result: AuthResult };

const fieldMessages = {
  email: "Enter a valid email address.",
  password: "Use between 12 and 128 characters.",
  confirmPassword: "The passwords do not match.",
  displayName: "Use between 1 and 80 characters for your name.",
  defaultContentLanguage: "Choose a language from the list.",
} satisfies Record<AccountField, string>;

export function validateAuthForm(mode: AuthMode, values: AuthValues): AccountFieldErrors {
  const payload = { email: values.email, password: values.password };
  const parsed = mode === "login" ? SignInInputSchema.safeParse(payload)
    : mode === "signup" ? SignUpInputSchema.safeParse({ ...payload, ...(values.displayName.trim() ? { displayName: values.displayName } : {}) })
      : mode === "forgot-password" ? PasswordResetRequestSchema.safeParse({ email: values.email })
        : UpdatePasswordInputSchema.safeParse({ password: values.password });
  const fields: AccountFieldErrors = {};
  if (!parsed.success) for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "email" || field === "displayName" || field === "password") {
      fields[field] = field === "password" && mode === "login" ? "Enter your password, up to 128 characters." : fieldMessages[field];
    }
  }
  if ((mode === "signup" || mode === "reset-password") && values.password !== values.confirmPassword) fields.confirmPassword = fieldMessages.confirmPassword;
  return fields;
}

export async function submitAuthForm(
  port: AccountPort, mode: AuthMode, values: AuthValues, returnTo: string, signal: AbortSignal,
): Promise<AuthSubmission> {
  signal.throwIfAborted();
  const fields = validateAuthForm(mode, values);
  if (Object.keys(fields).length) return { kind: "invalid", fields };
  const destination = safeReturnTo(returnTo);
  let result: ServiceResult<AuthResult>;
  if (mode === "login") result = await port.signIn({ email: values.email.trim(), password: values.password, returnTo: destination }, signal);
  else if (mode === "signup") result = await port.signUp({ email: values.email.trim(), password: values.password, returnTo: destination,
    ...(values.displayName.trim() ? { displayName: values.displayName.trim() } : {}) }, signal);
  else if (mode === "forgot-password") result = await port.requestPasswordReset({ email: values.email.trim(), returnTo: destination }, signal);
  else result = await port.updatePassword({ password: values.password, returnTo: destination }, signal);
  signal.throwIfAborted();
  return result.ok ? { kind: "complete", result: result.data } : { kind: "failed", error: result.error };
}

export function accountErrorMessage(error: ApiError): string {
  const detail = error.error;
  if (detail.messageKey === "auth.invalidCredentials") return "The email or password was not accepted. Check both and try again.";
  if (detail.messageKey === "auth.emailConfirmationRequired") return "This account still requires email confirmation, but email delivery is not available. Contact the site owner for help.";
  if (detail.code === "rate_limited") return "Too many attempts. Wait a moment, then try again.";
  if (detail.code === "revision_conflict") return "Your profile changed in another tab. Load the latest version before saving again. Your edits are still here.";
  if (detail.code === "unauthenticated") return "Your session has ended. Sign in again to continue.";
  if (detail.code === "invalid_input") return "Check the highlighted fields and try again.";
  if (detail.code === "forbidden") return "This action is not available for this session. Sign in again or request a new password link.";
  return "We could not reach the account service. Your entries are still here. Please try again.";
}

export function accountServerFields(error: ApiError, mode?: AuthMode): AccountFieldErrors {
  const fields: AccountFieldErrors = {};
  for (const [field, messageKey] of Object.entries(error.error.fieldErrors ?? {})) {
    if (field in fieldMessages) {
      const key = field as AccountField;
      fields[key] = key === "password" && messageKey === "auth.passwordUnchanged" ? "Choose a password you have not used for this account before."
        : key === "password" && messageKey === "auth.passwordTooWeak" ? "Choose a stronger password with a less predictable combination of words or characters."
          : key === "password" && mode === "login" ? "Enter your password, up to 128 characters." : fieldMessages[key];
    }
  }
  return fields;
}

export function authContinuationText(returnTo: string): string | undefined {
  const destination = safeReturnTo(returnTo);
  if (destination.startsWith("/start/") || destination.startsWith("/learn/") || destination.startsWith("/s/")) return "After signing in, you will continue to the course you chose.";
  if (destination.startsWith("/chat")) return "After signing in, you will return to your conversation.";
  if (destination.startsWith("/library")) return "After signing in, you will return to your library.";
  return undefined;
}
