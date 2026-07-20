export function isGoogleAuthEnabled(): boolean {
  return process.env.GOOGLE_AUTH_ENABLED === "true";
}
