import { safeReturnTo } from "./auth-return-to";

function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new RangeError("A route identifier must name a nonempty path segment");
  }

  return encodeURIComponent(value);
}

function authPath(path: string, returnTo?: string): string {
  const destination = safeReturnTo(returnTo);
  return destination === "/" ? path : `${path}?${new URLSearchParams({ returnTo: destination })}`;
}

export const routes = {
  home: "/",
  explore: "/explore",
  library: "/library",
  try: "/try",
  about: "/about",
  help: "/help",
  privacy: "/privacy",
  account: "/account",
  login: (returnTo?: string): string => authPath("/login", returnTo),
  signup: (returnTo?: string): string => authPath("/signup", returnTo),
  forgotPassword: (returnTo?: string): string => authPath("/forgot-password", returnTo),
  resetPassword: (returnTo?: string): string => authPath("/reset-password", returnTo),
  course: (slug: string): string => `/courses/${pathSegment(slug)}`,
  chat: (conversationId?: string): string =>
    conversationId === undefined ? "/chat" : `/chat?conversation=${encodeURIComponent(conversationId)}`,
  create: (): string => "/chat",
  learn: (enrollmentId: string): string => `/learn/${pathSegment(enrollmentId)}`,
} as const;
