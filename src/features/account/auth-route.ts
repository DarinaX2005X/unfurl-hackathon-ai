import { safeReturnTo } from "@/lib/auth-return-to";

export type AuthSearchParams = Record<string, string | string[] | undefined>;
export type AuthCallbackError = "expired_link" | "service_unavailable" | null;

export function authRouteInput(params: AuthSearchParams) {
  return {
    returnTo: safeReturnTo(params.returnTo),
    callbackError: (params.error === "expired_link" || params.error === "service_unavailable" ? params.error : null) as AuthCallbackError,
  };
}
