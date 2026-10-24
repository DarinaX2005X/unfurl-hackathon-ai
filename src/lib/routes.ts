function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new RangeError("A route identifier must name a nonempty path segment");
  }

  return encodeURIComponent(value);
}

export const routes = {
  home: "/",
  explore: "/explore",
  library: "/library",
  try: "/try",
  about: "/about",
  help: "/help",
  privacy: "/privacy",
  course: (slug: string): string => `/courses/${pathSegment(slug)}`,
  chat: (conversationId?: string): string =>
    conversationId === undefined ? "/chat" : `/chat?conversation=${encodeURIComponent(conversationId)}`,
  create: (): string => "/chat",
  learn: (enrollmentId: string): string => `/learn/${pathSegment(enrollmentId)}`,
} as const;
