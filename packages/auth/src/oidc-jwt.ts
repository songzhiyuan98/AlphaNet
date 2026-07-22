import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export const OIDC_JWT_SIGNING_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
export type OidcJwtSigningAlgorithm = (typeof OIDC_JWT_SIGNING_ALGORITHMS)[number];

export interface OidcMfaPolicy {
  /** Exact OIDC `acr` values accepted as proof of MFA. */
  allowedAcrValues: readonly string[];
  /** Whether an `amr` array containing the exact value `mfa` is accepted. */
  allowAmrMfa: boolean;
}

export interface OidcJwtVerifierConfig {
  algorithms: readonly OidcJwtSigningAlgorithm[];
  audience: string;
  clockToleranceSeconds?: number | undefined;
  issuer: string;
  jwksUri: string;
  mfa: OidcMfaPolicy;
}

export interface OidcMfaEvidence {
  amrMfa: boolean;
  matchedAcr: string | null;
  method: "acr" | "amr_mfa" | "acr_and_amr_mfa";
}

export interface VerifiedOidcJwtIdentity {
  issuer: string;
  mfa: OidcMfaEvidence;
  subject: string;
}

export interface OidcJwtVerifier {
  verify(token: string): Promise<VerifiedOidcJwtIdentity>;
}

export type OidcJwtVerificationFailure =
  "identity_provider_unavailable" | "invalid_token";

/**
 * A deliberately claim-free verification error. Callers may log its name/code,
 * but never receive the JWT, JOSE header, payload, or the provider error text.
 */
export class OidcJwtVerificationError extends Error {
  readonly code: OidcJwtVerificationFailure;

  constructor(code: OidcJwtVerificationFailure) {
    super(
      code === "invalid_token"
        ? "The OIDC token is invalid."
        : "The OIDC identity provider is unavailable.",
    );
    this.name = "OidcJwtVerificationError";
    this.code = code;
  }
}

export interface OidcJwtVerifierDependencies {
  /** Test/embedded resolver override. Production callers use the configured remote JWKS. */
  keyResolver?: JWTVerifyGetKey | undefined;
  now?: (() => Date) | undefined;
}

const safeClaimValuePattern = /^[\x21-\x7e]+$/;
const signingAlgorithmSet = new Set<string>(OIDC_JWT_SIGNING_ALGORITHMS);

function assertCanonicalProviderUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol === "http:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]")
  ) {
    throw new Error(
      `${field} must be an https URL (or loopback http URL) without credentials or fragment`,
    );
  }
  return url;
}

function assertSafeConfiguredValue(value: string, field: string, maximum: number): void {
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !safeClaimValuePattern.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function validateConfig(config: OidcJwtVerifierConfig): void {
  const issuer = assertCanonicalProviderUrl(config.issuer, "issuer");
  assertCanonicalProviderUrl(config.jwksUri, "jwksUri");
  if (issuer.search !== "" || issuer.hash !== "") {
    throw new Error("issuer must not contain a query or fragment");
  }
  assertSafeConfiguredValue(config.audience, "audience", 200);

  if (
    config.algorithms.length < 1 ||
    new Set(config.algorithms).size !== config.algorithms.length ||
    config.algorithms.some((algorithm) => !signingAlgorithmSet.has(algorithm))
  ) {
    throw new Error("algorithms must contain unique supported asymmetric algorithms");
  }

  if (
    config.mfa.allowedAcrValues.length > 20 ||
    new Set(config.mfa.allowedAcrValues).size !== config.mfa.allowedAcrValues.length
  ) {
    throw new Error("MFA acr values must be unique and contain at most 20 entries");
  }
  for (const acr of config.mfa.allowedAcrValues) {
    assertSafeConfiguredValue(acr, "MFA acr value", 200);
  }
  if (!config.mfa.allowAmrMfa && config.mfa.allowedAcrValues.length === 0) {
    throw new Error("at least one MFA assurance mechanism must be enabled");
  }

  const tolerance = config.clockToleranceSeconds ?? 5;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 60) {
    throw new Error("clockToleranceSeconds must be an integer from 0 to 60");
  }
}

function safeSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    value.trim() === value &&
    safeClaimValuePattern.test(value)
  );
}

function parseAcr(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    !safeClaimValuePattern.test(value)
  ) {
    throw new OidcJwtVerificationError("invalid_token");
  }
  return value;
}

function parseAmr(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 100 ||
        item.trim() !== item ||
        !safeClaimValuePattern.test(item),
    )
  ) {
    throw new OidcJwtVerificationError("invalid_token");
  }
  return value as string[];
}

function mfaEvidence(
  acr: string | null,
  amr: readonly string[],
  policy: OidcMfaPolicy,
): OidcMfaEvidence {
  const matchedAcr = acr !== null && policy.allowedAcrValues.includes(acr) ? acr : null;
  const amrMfa = policy.allowAmrMfa && amr.includes("mfa");
  if (matchedAcr === null && !amrMfa) {
    throw new OidcJwtVerificationError("invalid_token");
  }
  return Object.freeze({
    amrMfa,
    matchedAcr,
    method:
      matchedAcr !== null && amrMfa
        ? "acr_and_amr_mfa"
        : matchedAcr !== null
          ? "acr"
          : "amr_mfa",
  });
}

function isProviderFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid ||
    (error instanceof errors.JOSEError && error.code === errors.JOSEError.code) ||
    !(error instanceof errors.JOSEError)
  );
}

/**
 * Verifies signed OIDC JWTs against one operator-configured remote JWKS. The
 * resolver never follows token-controlled `jku`/`x5u` locations, and accepted
 * algorithms are restricted to the explicit asymmetric allowlist.
 */
export function createOidcJwtVerifier(
  config: OidcJwtVerifierConfig,
  dependencies: OidcJwtVerifierDependencies = {},
): OidcJwtVerifier {
  validateConfig(config);
  const keyResolver =
    dependencies.keyResolver ??
    createRemoteJWKSet(new URL(config.jwksUri), {
      cacheMaxAge: 10 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 2_000,
    });
  const clockTolerance = config.clockToleranceSeconds ?? 5;

  return Object.freeze({
    verify: async (token: string): Promise<VerifiedOidcJwtIdentity> => {
      try {
        const result = await jwtVerify(token, keyResolver, {
          algorithms: [...config.algorithms],
          audience: config.audience,
          clockTolerance,
          ...(dependencies.now ? { currentDate: dependencies.now() } : {}),
          issuer: config.issuer,
          // OIDC providers do not universally emit `nbf`. jose still enforces
          // it whenever present; only expiry and subject are mandatory here.
          requiredClaims: ["exp", "sub"],
        });
        if (!safeSubject(result.payload.sub)) {
          throw new OidcJwtVerificationError("invalid_token");
        }
        const acr = parseAcr(result.payload.acr);
        const amr = parseAmr(result.payload.amr);

        return Object.freeze({
          issuer: config.issuer,
          mfa: mfaEvidence(acr, amr, config.mfa),
          subject: result.payload.sub,
        });
      } catch (error) {
        if (error instanceof OidcJwtVerificationError) throw error;
        throw new OidcJwtVerificationError(
          isProviderFailure(error) ? "identity_provider_unavailable" : "invalid_token",
        );
      }
    },
  });
}
