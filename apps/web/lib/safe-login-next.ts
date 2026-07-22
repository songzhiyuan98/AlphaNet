export type LoginNextValue = string | string[] | undefined;

const allowedLoginDestinations = new Set([
  "/home",
  "/notifications",
  "/settings/agents",
  "/settings/approvals",
  "/settings/credentials",
]);

export function safeLoginNextPath(value: LoginNextValue): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && allowedLoginDestinations.has(candidate) ? candidate : "/home";
}
