function segment(value: string): string {
  if (!value || value === "." || value === "..") throw new RangeError("Invalid route identifier");
  return encodeURIComponent(value);
}

export function startCoursePath(courseId: string, versionId: string, shareToken?: string): string {
  const query = new URLSearchParams({ version: versionId });
  if (shareToken) query.set("share", shareToken);
  return `/start/${segment(courseId)}?${query}`;
}
