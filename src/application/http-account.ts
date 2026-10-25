import { z } from "zod";
import {
  AuthenticatedResultSchema, PasswordResetRequestedSchema, PasswordUpdatedSchema,
  ProfileSchema, SignedOutSchema,
} from "../domain/account";
import { ApiErrorSchema, type ApiError } from "../domain/errors";
import { AccountStateSchema, type AccountPort } from "./account-port";
import type { ServiceResult } from "./ports";

function unavailable(requestId: string): ApiError {
  return { error: { code: "service_unavailable", messageKey: "auth.unavailable", retryable: true, requestId } };
}

export function createHttpAccount(fetcher: typeof fetch = (...args) => fetch(...args)): AccountPort {
  async function request<T>(
    path: string, method: "GET" | "POST" | "PATCH", schema: z.ZodType<T>,
    body?: unknown, signal?: AbortSignal,
  ): Promise<ServiceResult<T>> {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    try {
      const response = await fetcher(path, {
        method, credentials: "same-origin", cache: "no-store",
        headers: {
          Accept: "application/json", "X-Request-Id": requestId,
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          ...(method === "PATCH" ? { "Idempotency-Key": requestId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      const payload: unknown = await response.json();
      signal?.throwIfAborted();
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(payload);
        return { ok: false, error: parsed.success ? parsed.data : unavailable(requestId) };
      }
      const parsed = z.object({ data: schema }).strict().safeParse(payload);
      return parsed.success
        ? { ok: true, data: parsed.data.data }
        : { ok: false, error: unavailable(requestId) };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return { ok: false, error: unavailable(requestId) };
    }
  }

  return {
    getSession: (signal) => request("/api/v1/me", "GET", AccountStateSchema, undefined, signal),
    signIn: (input, signal) => request("/api/auth/sign-in", "POST", AuthenticatedResultSchema, input, signal),
    signUp: (input, signal) => request("/api/auth/sign-up", "POST", AuthenticatedResultSchema, input, signal),
    requestPasswordReset: (input, signal) => request("/api/auth/forgot-password", "POST", PasswordResetRequestedSchema, input, signal),
    updatePassword: (input, signal) => request("/api/auth/reset-password", "POST", PasswordUpdatedSchema, input, signal),
    signOut: (signal) => request("/api/auth/sign-out", "POST", SignedOutSchema, {}, signal),
    updateProfile: (input, signal) => request("/api/v1/me/profile", "PATCH", ProfileSchema, input, signal),
  };
}

export const httpAccount: AccountPort = createHttpAccount();
