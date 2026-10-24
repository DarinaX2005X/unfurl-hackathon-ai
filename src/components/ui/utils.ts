export function classes(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function describedBy(...ids: Array<string | false | undefined>): string | undefined {
  const result = ids.filter(Boolean).join(" ");
  return result || undefined;
}

export function isAriaDisabled(value: boolean | "true" | "false" | undefined): boolean {
  return value === true || value === "true";
}
