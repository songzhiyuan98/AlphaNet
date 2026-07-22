import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AgentScopeSchema, type AgentScope } from "@alphanet/contracts";
import { SignJWT, errors, jwtVerify } from "jose";
import { z } from "zod";

export const MCP_ACTOR_ASSERTION_ISSUER = "urn:alphanet:service:mcp";
export const MCP_ACTOR_ASSERTION_AUDIENCE = "urn:alphanet:service:api:actor-context:v1";
export const MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS = 30;
const MCP_TOKEN_JTI_DIGEST_DOMAIN = "alphanet:oauth_access_token_jti:v1\0";

const UuidSchema = z.uuid();
const InboundTokenJtiSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 512)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    }),
  );
const TokenJtiDigestSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected a 32-byte base64url digest.")
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  }, "Expected a canonical 32-byte base64url digest.");

const ActorContextAssertionPayloadSchema = z
  .object({
    aud: z.union([
      z.literal(MCP_ACTOR_ASSERTION_AUDIENCE),
      z.array(z.literal(MCP_ACTOR_ASSERTION_AUDIENCE)).length(1),
    ]),
    credential_id: UuidSchema,
    exp: z.number().int().positive().safe(),
    iat: z.number().int().positive().safe(),
    iss: z.literal(MCP_ACTOR_ASSERTION_ISSUER),
    jti: UuidSchema,
    nbf: z.number().int().positive().safe(),
    request_id: z.string().min(1).max(200),
    scopes: z
      .array(AgentScopeSchema)
      .min(1)
      .refine((values) => {
        return new Set(values).size === values.length;
      }, "ActorContext scopes must be unique."),
    sub: UuidSchema,
    token_jti_digest: TokenJtiDigestSchema,
  })
  .strict();

export interface McpActorAssertionKey {
  /** HMAC key material. It must be independently generated for this trust boundary. */
  key: Uint8Array;
  /**
   * Hard verification cutoff for a rotated key. The current signing key must
   * use null; every prior key must have a finite cutoff.
   */
  verificationExpiresAt: Date | null;
}

export interface McpActorAssertionKeyRing {
  currentVersion: number;
  keys: Readonly<Record<number, McpActorAssertionKey>>;
}

export interface CreateMcpActorContextAssertionInput {
  credentialId: string;
  grantId: string;
  requestId: string;
  scopes: readonly AgentScope[];
  tokenJtiDigest: string;
}

export interface CreateMcpActorContextAssertionOptions {
  now?: Date | undefined;
  ttlSeconds?: number | undefined;
}

export interface VerifiedMcpActorContextAssertion {
  credentialId: string;
  expiresAt: Date;
  grantId: string;
  issuedAt: Date;
  jti: string;
  notBefore: Date;
  requestId: string;
  scopes: AgentScope[];
  tokenJtiDigest: string;
}

export type McpActorContextAssertionErrorCode =
  | "ASSERTION_EXPIRED"
  | "ASSERTION_INVALID"
  | "ASSERTION_KEY_INVALID"
  | "ASSERTION_KEY_RETIRED"
  | "ASSERTION_KEY_UNKNOWN"
  | "ASSERTION_TOKEN_JTI_INVALID"
  | "ASSERTION_TTL_INVALID";

export class McpActorContextAssertionError extends Error {
  readonly code: McpActorContextAssertionErrorCode;

  constructor(code: McpActorContextAssertionErrorCode) {
    super(code);
    this.name = "McpActorContextAssertionError";
    this.code = code;
  }
}

function validateKeyRing(keyRing: McpActorAssertionKeyRing): void {
  assertionKeyId(keyRing.currentVersion);
  const entries = Object.entries(keyRing.keys);
  if (entries.length < 1) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
  }
  for (const [rawVersion, entry] of entries) {
    const version = Number(rawVersion);
    if (
      !Number.isSafeInteger(version) ||
      version <= 0 ||
      !entry ||
      !(entry.key instanceof Uint8Array) ||
      entry.key.byteLength < 32
    ) {
      throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
    }
    if (version === keyRing.currentVersion) {
      if (entry.verificationExpiresAt !== null) {
        throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
      }
    } else if (
      !(entry.verificationExpiresAt instanceof Date) ||
      !Number.isFinite(entry.verificationExpiresAt.valueOf())
    ) {
      throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
    }
  }
  if (!keyRing.keys[keyRing.currentVersion]) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_UNKNOWN");
  }
}

function assertionKey(
  keyRing: McpActorAssertionKeyRing,
  version: number,
  now: Date,
): Uint8Array {
  const entry = keyRing.keys[version];
  if (!entry) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_UNKNOWN");
  }
  if (entry.key.byteLength < 32) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
  }
  if (
    entry.verificationExpiresAt !== null &&
    entry.verificationExpiresAt.valueOf() <= now.valueOf()
  ) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_RETIRED");
  }
  return entry.key;
}

function assertionKeyId(version: number): string {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
  }
  return `v${version}`;
}

function keyVersion(keyId: unknown): number {
  if (typeof keyId !== "string" || !/^v[1-9][0-9]*$/.test(keyId)) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_UNKNOWN");
  }
  const version = Number(keyId.slice(1));
  if (!Number.isSafeInteger(version)) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_UNKNOWN");
  }
  return version;
}

export function digestInboundMcpTokenJti(jti: string, digestKey: Uint8Array): string {
  if (digestKey.byteLength < 32) {
    throw new McpActorContextAssertionError("ASSERTION_KEY_INVALID");
  }
  if (!InboundTokenJtiSchema.safeParse(jti).success) {
    throw new McpActorContextAssertionError("ASSERTION_TOKEN_JTI_INVALID");
  }
  return createHmac("sha256", digestKey)
    .update(MCP_TOKEN_JTI_DIGEST_DOMAIN, "utf8")
    .update(jti, "utf8")
    .digest("base64url");
}

export async function createMcpActorContextAssertion(
  input: CreateMcpActorContextAssertionInput,
  keyRing: McpActorAssertionKeyRing,
  options: CreateMcpActorContextAssertionOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  validateKeyRing(keyRing);
  const issuedAt = Math.floor(now.valueOf() / 1_000);
  const ttlSeconds = options.ttlSeconds ?? MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS
  ) {
    throw new McpActorContextAssertionError("ASSERTION_TTL_INVALID");
  }
  const parsedScopes = z.array(AgentScopeSchema).min(1).safeParse(input.scopes);
  if (
    !parsedScopes.success ||
    new Set(parsedScopes.data).size !== parsedScopes.data.length
  ) {
    throw new McpActorContextAssertionError("ASSERTION_INVALID");
  }
  if (
    !UuidSchema.safeParse(input.credentialId).success ||
    !UuidSchema.safeParse(input.grantId).success ||
    !TokenJtiDigestSchema.safeParse(input.tokenJtiDigest).success ||
    input.requestId.length < 1 ||
    input.requestId.length > 200
  ) {
    throw new McpActorContextAssertionError("ASSERTION_INVALID");
  }
  const scopes = parsedScopes.data;

  const version = keyRing.currentVersion;
  const key = assertionKey(keyRing, version, now);
  return new SignJWT({
    credential_id: input.credentialId,
    request_id: input.requestId,
    scopes,
    token_jti_digest: input.tokenJtiDigest,
  })
    .setProtectedHeader({ alg: "HS256", kid: assertionKeyId(version), typ: "JWT" })
    .setIssuer(MCP_ACTOR_ASSERTION_ISSUER)
    .setAudience(MCP_ACTOR_ASSERTION_AUDIENCE)
    .setSubject(input.grantId)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(key);
}

export async function verifyMcpActorContextAssertion(
  assertion: string,
  keyRing: McpActorAssertionKeyRing,
  now = new Date(),
): Promise<VerifiedMcpActorContextAssertion> {
  if (assertion.length < 1 || assertion.length > 8_192) {
    throw new McpActorContextAssertionError("ASSERTION_INVALID");
  }
  validateKeyRing(keyRing);
  try {
    const { payload } = await jwtVerify(
      assertion,
      (protectedHeader) => {
        if (protectedHeader.alg !== "HS256" || protectedHeader.typ !== "JWT") {
          throw new McpActorContextAssertionError("ASSERTION_INVALID");
        }
        return assertionKey(keyRing, keyVersion(protectedHeader.kid), now);
      },
      {
        algorithms: ["HS256"],
        audience: MCP_ACTOR_ASSERTION_AUDIENCE,
        clockTolerance: 2,
        currentDate: now,
        issuer: MCP_ACTOR_ASSERTION_ISSUER,
        maxTokenAge: `${MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS + 2}s`,
        requiredClaims: ["sub", "jti", "iat", "nbf", "exp"],
      },
    );
    const parsed = ActorContextAssertionPayloadSchema.parse(payload);
    if (
      parsed.exp - parsed.iat > MCP_ACTOR_ASSERTION_MAX_TTL_SECONDS ||
      parsed.nbf < parsed.iat ||
      parsed.nbf > parsed.exp
    ) {
      throw new McpActorContextAssertionError("ASSERTION_TTL_INVALID");
    }
    return {
      credentialId: parsed.credential_id,
      expiresAt: new Date(parsed.exp * 1_000),
      grantId: parsed.sub,
      issuedAt: new Date(parsed.iat * 1_000),
      jti: parsed.jti,
      notBefore: new Date(parsed.nbf * 1_000),
      requestId: parsed.request_id,
      scopes: parsed.scopes,
      tokenJtiDigest: parsed.token_jti_digest,
    };
  } catch (error) {
    if (error instanceof McpActorContextAssertionError) {
      throw error;
    }
    if (
      error instanceof errors.JWTExpired ||
      (error instanceof errors.JWTClaimValidationFailed &&
        ["exp", "iat", "nbf"].includes(error.claim))
    ) {
      throw new McpActorContextAssertionError("ASSERTION_EXPIRED");
    }
    throw new McpActorContextAssertionError("ASSERTION_INVALID");
  }
}

export function actorContextTokenDigestMatches(
  expected: string,
  candidate: string,
): boolean {
  if (!TokenJtiDigestSchema.safeParse(expected).success) {
    return false;
  }
  if (!TokenJtiDigestSchema.safeParse(candidate).success) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}
