import "server-only";
import type { ApiError, ApiErrorCode } from "../../domain/errors";

export class ServiceFault extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly messageKey: string,
    readonly retryable = false,
    readonly details: { fieldErrors?: Record<string, string>; currentRevision?: number } = {},
  ) {
    super(messageKey);
    this.name = "ServiceFault";
  }

  toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code, messageKey: this.messageKey, retryable: this.retryable, requestId,
        ...(this.details.fieldErrors ? { fieldErrors: this.details.fieldErrors } : {}),
      },
      ...(this.details.currentRevision === undefined ? {} : { currentRevision: this.details.currentRevision }),
    };
  }
}

export function unavailable(messageKey = "auth.unavailable"): ServiceFault {
  return new ServiceFault(503, "service_unavailable", messageKey, true);
}

export function providerFault(error: { code?: string | undefined; status?: number | undefined }): ServiceFault {
  if (error.status === 429 || error.code?.startsWith("over_")) {
    return new ServiceFault(429, "rate_limited", "auth.rateLimited", true);
  }
  if (error.code === "email_not_confirmed") return new ServiceFault(403, "forbidden", "auth.emailConfirmationRequired");
  if (error.code === "invalid_credentials" || error.status === 401 || error.code === "user_not_found" || error.code === "user_banned") {
    return new ServiceFault(401, "unauthenticated", "auth.invalidCredentials");
  }
  if (error.code === "weak_password" || error.code === "same_password") {
    return new ServiceFault(400, "invalid_input", "auth.invalidInput", false, {
      fieldErrors: { password: error.code === "same_password" ? "auth.passwordUnchanged" : "auth.passwordTooWeak" },
    });
  }
  if (error.code === "reauthentication_needed" || error.code === "reauthentication_not_valid") {
    return new ServiceFault(401, "unauthenticated", "auth.reauthenticationRequired");
  }
  if (error.code === "email_address_invalid" || error.code === "validation_failed") {
    return new ServiceFault(400, "invalid_input", "auth.invalidInput");
  }
  return unavailable();
}
