export type SearchParamValue = string | string[] | undefined;

const MAX_CURSOR_LENGTH = 4_096;

export function readForwardCursor(value: SearchParamValue): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH
  ) {
    return undefined;
  }
  return value;
}

export function forwardPageHref(
  pathname: string,
  cursor: string | null,
  preserved: Readonly<Record<string, string | undefined>> = {},
): string | null {
  if (cursor === null || cursor.length === 0) return null;

  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(preserved)) {
    if (value !== undefined && value.length > 0) parameters.set(name, value);
  }
  parameters.set("cursor", cursor);
  return `${pathname}?${parameters.toString()}`;
}

export function currentPageHref(
  pathname: string,
  parameters: Readonly<Record<string, string | undefined>> = {},
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value.length > 0) query.set(name, value);
  }
  const serialized = query.toString();
  return serialized.length > 0 ? `${pathname}?${serialized}` : pathname;
}
