interface ResetTokenLocation {
  hash: string;
  pathname: string;
}

interface ResetTokenHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function consumeResetToken(
  location: ResetTokenLocation,
  history: ResetTokenHistory,
): string | null {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token");

  // Drop both fragment and query parameters immediately. Password reset needs
  // no other URL state, and a legacy ?token= value must not survive in history.
  history.replaceState(null, "", location.pathname);

  return token && token.length > 0 ? token : null;
}
