import { OWNER_SESSION_FRESH_AGE_SECONDS } from "@alphanet/auth";

export function isFreshOwnerSession(createdAt: Date, now: Date): boolean {
  const ageMilliseconds = now.valueOf() - createdAt.valueOf();
  return (
    Number.isFinite(ageMilliseconds) &&
    ageMilliseconds >= -60_000 &&
    ageMilliseconds < OWNER_SESSION_FRESH_AGE_SECONDS * 1_000
  );
}
