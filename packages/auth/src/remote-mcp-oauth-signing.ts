import { randomUUID } from "node:crypto";

import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from "jose";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const ALGORITHM = "ES256" as const;
const CURVE = "P-256" as const;
const KEY_USE = "sig" as const;
const TOKEN_TYPE = "JWT" as const;
const ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
const PUBLIC_GRACE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
const JWKS_MAX_AGE_SECONDS = 300;
const JWKS_ORIGIN_CACHE_MS = 30_000;
// A replacement key is public before it signs. This exceeds both the public
// cache lifetime and the short origin cache, leaving a conservative buffer for
// edge propagation and ordinary clock skew between API replicas.
const JWKS_ROTATION_WARMUP_MS = 10 * 60 * 1_000;
const KEY_LOCK_NAME = "alphanet:remote-mcp-oauth:es256-signing-key:v1";

export type RemoteMcpOAuthSigningErrorCode =
  | "CONFIG_INVALID"
  | "JWKS_UNAVAILABLE"
  | "SIGNING_FAILED"
  | "SIGNING_KEY_INVALID"
  | "SIGNING_KEY_UNAVAILABLE";

export class RemoteMcpOAuthSigningError extends Error {
  readonly code: RemoteMcpOAuthSigningErrorCode;

  constructor(code: RemoteMcpOAuthSigningErrorCode) {
    super(`Remote MCP OAuth signing service failed (${code})`);
    this.name = "RemoteMcpOAuthSigningError";
    this.code = code;
  }
}

export interface RemoteMcpOAuthPublicJwk {
  alg: typeof ALGORITHM;
  crv: typeof CURVE;
  kid: string;
  kty: "EC";
  use: typeof KEY_USE;
  x: string;
  y: string;
}

export interface RemoteMcpOAuthJwksDocument {
  keys: RemoteMcpOAuthPublicJwk[];
}

export interface RemoteMcpOAuthJwksResult {
  cacheControl: `public, max-age=${number}, must-revalidate`;
  document: RemoteMcpOAuthJwksDocument;
}

export interface AlphaNetRemoteMcpOAuthSigningService {
  checkReady(): Promise<void>;
  getPublicJwks(): Promise<RemoteMcpOAuthJwksResult>;
  signAccessToken(payload: JWTPayload): Promise<string>;
}

export interface AlphaNetRemoteMcpOAuthSigningOptions {
  /** Dedicated 32-byte key; config must keep it independent from every other auth key. */
  jwkEncryptionKey: Uint8Array;
  pool: Pick<Pool, "connect" | "query">;
  /** Test-only clock seam. Production callers should omit it. */
  now?: () => Date;
}

interface OAuthPublicJwkRow extends QueryResultRow {
  created_at: Date | string;
  expires_at: Date | string | null;
  id: string;
  public_key: string;
}

interface OAuthJwkRow extends OAuthPublicJwkRow {
  private_key: string;
}

interface CurrentSigningKey {
  inserted: boolean;
  row: OAuthJwkRow;
}

interface CachedPublicJwks {
  expiresAt: number;
  result: RemoteMcpOAuthJwksResult;
}

function serviceError(code: RemoteMcpOAuthSigningErrorCode): RemoteMcpOAuthSigningError {
  return new RemoteMcpOAuthSigningError(code);
}

function encodeEncryptionKey(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw serviceError("CONFIG_INVALID");
  }
  // Better Auth's symmetric crypto accepts strings. Base64url is a stable,
  // lossless encoding and Buffer.from copies the caller-owned key first.
  return Buffer.from(value).toString("base64url");
}

function isBase64UrlCoordinate(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function parseDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw serviceError("SIGNING_KEY_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw serviceError("SIGNING_KEY_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function publicJwkFromRow(row: OAuthPublicJwkRow): RemoteMcpOAuthPublicJwk {
  const key = parseJsonObject(row.public_key);
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    key.kty !== "EC" ||
    key.crv !== CURVE ||
    (key.alg !== undefined && key.alg !== ALGORITHM) ||
    (key.use !== undefined && key.use !== KEY_USE) ||
    (key.kid !== undefined && key.kid !== row.id) ||
    !isBase64UrlCoordinate(key.x) ||
    !isBase64UrlCoordinate(key.y) ||
    "d" in key
  ) {
    throw serviceError("SIGNING_KEY_INVALID");
  }

  return {
    alg: ALGORITHM,
    crv: CURVE,
    kid: row.id,
    kty: "EC",
    use: KEY_USE,
    x: key.x,
    y: key.y,
  };
}

function validateRowDates(row: OAuthPublicJwkRow): void {
  const createdAt = parseDate(row.created_at);
  const expiresAt = parseDate(row.expires_at);
  if (!createdAt || !expiresAt || expiresAt.getTime() <= createdAt.getTime()) {
    throw serviceError("SIGNING_KEY_INVALID");
  }
}

function cloneJwksResult(result: RemoteMcpOAuthJwksResult): RemoteMcpOAuthJwksResult {
  return {
    cacheControl: result.cacheControl,
    document: { keys: result.document.keys.map((key) => ({ ...key })) },
  };
}

async function createEncryptedKeyRow(
  secret: string,
  createdAt: Date,
): Promise<OAuthJwkRow> {
  try {
    const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, {
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    const encryptedPrivateJwk = await symmetricEncrypt({
      data: JSON.stringify(privateJwk),
      key: secret,
    });

    return {
      created_at: createdAt,
      expires_at: new Date(
        createdAt.getTime() + ROTATION_INTERVAL_MS + PUBLIC_GRACE_INTERVAL_MS,
      ),
      id: randomUUID(),
      private_key: JSON.stringify(encryptedPrivateJwk),
      public_key: JSON.stringify(publicJwk),
    };
  } catch {
    throw serviceError("SIGNING_KEY_UNAVAILABLE");
  }
}

async function importPrivateKey(row: OAuthJwkRow, secret: string): Promise<CryptoKey> {
  const publicJwk = publicJwkFromRow(row);
  let encryptedPrivateJwk: unknown;
  try {
    encryptedPrivateJwk = JSON.parse(row.private_key);
  } catch {
    throw serviceError("SIGNING_KEY_INVALID");
  }
  if (typeof encryptedPrivateJwk !== "string" || encryptedPrivateJwk.length === 0) {
    throw serviceError("SIGNING_KEY_INVALID");
  }

  try {
    const decrypted = await symmetricDecrypt({ data: encryptedPrivateJwk, key: secret });
    const privateJwk = parseJsonObject(decrypted);
    if (
      privateJwk.kty !== "EC" ||
      privateJwk.crv !== CURVE ||
      privateJwk.x !== publicJwk.x ||
      privateJwk.y !== publicJwk.y ||
      !isBase64UrlCoordinate(privateJwk.d)
    ) {
      throw serviceError("SIGNING_KEY_INVALID");
    }
    return (await importJWK(privateJwk, ALGORITHM)) as CryptoKey;
  } catch (error) {
    if (error instanceof RemoteMcpOAuthSigningError) throw error;
    throw serviceError("SIGNING_KEY_INVALID");
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // The original, deliberately sanitized error is more useful to the caller.
  }
}

export function createAlphaNetRemoteMcpOAuthSigningService(
  options: AlphaNetRemoteMcpOAuthSigningOptions,
): AlphaNetRemoteMcpOAuthSigningService {
  if (
    !options ||
    !options.pool ||
    typeof options.pool.connect !== "function" ||
    typeof options.pool.query !== "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw serviceError("CONFIG_INVALID");
  }

  const { pool } = options;
  const encryptionSecret = encodeEncryptionKey(options.jwkEncryptionKey);
  const now = options.now ?? (() => new Date());
  let publicJwksCache: CachedPublicJwks | undefined;
  let publicJwksLoad: Promise<RemoteMcpOAuthJwksResult> | undefined;

  async function ensureCurrentKey(): Promise<CurrentSigningKey> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw serviceError("SIGNING_KEY_UNAVAILABLE");
    }

    let transactionStarted = false;
    try {
      await client.query("begin");
      transactionStarted = true;
      await client.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [KEY_LOCK_NAME],
      );

      const checkedAt = now();
      if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
        throw serviceError("SIGNING_KEY_UNAVAILABLE");
      }
      const rotationCutoff = new Date(checkedAt.getTime() - ROTATION_INTERVAL_MS);
      const active = await client.query<OAuthJwkRow>(
        `select id::text, public_key, private_key, created_at, expires_at
           from auth.oauth_jwks
          where expires_at > $1::timestamptz
          order by created_at desc, id desc
          limit 3
          for update`,
        [checkedAt],
      );

      if (active.rows.length > 2) throw serviceError("SIGNING_KEY_INVALID");
      for (const activeRow of active.rows) {
        validateRowDates(activeRow);
        publicJwkFromRow(activeRow);
      }
      const freshRows = active.rows.filter((activeRow) => {
        const createdAt = parseDate(activeRow.created_at);
        if (!createdAt) throw serviceError("SIGNING_KEY_INVALID");
        return createdAt.getTime() > rotationCutoff.getTime();
      });
      if (freshRows.length > 1) throw serviceError("SIGNING_KEY_INVALID");

      let didInsert = false;
      let newest = freshRows[0];
      if (!newest) {
        const publicGraceExpiresAt = new Date(
          checkedAt.getTime() + PUBLIC_GRACE_INTERVAL_MS,
        );
        await client.query(
          `update auth.oauth_jwks
              set expires_at = case
                when expires_at is null or expires_at < $1::timestamptz
                  then $1::timestamptz
                else expires_at
              end
            where id = (
              select id
               from auth.oauth_jwks
               where created_at <= $2::timestamptz
                 and expires_at > $3::timestamptz
               order by created_at desc, id desc
               limit 1
               for update
            )`,
          [publicGraceExpiresAt, rotationCutoff, checkedAt],
        );
        const generated = await createEncryptedKeyRow(encryptionSecret, checkedAt);
        const insertResult = await client.query<OAuthJwkRow>(
          `insert into auth.oauth_jwks
             (id, public_key, private_key, created_at, expires_at)
           values ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz)
           returning id::text, public_key, private_key, created_at, expires_at`,
          [
            generated.id,
            generated.public_key,
            generated.private_key,
            generated.created_at,
            generated.expires_at,
          ],
        );
        newest = insertResult.rows[0];
        if (!newest || insertResult.rows.length !== 1) {
          throw serviceError("SIGNING_KEY_UNAVAILABLE");
        }
        didInsert = true;
        active.rows.unshift(newest);
      }

      validateRowDates(newest);
      publicJwkFromRow(newest);
      const newestCreatedAt = parseDate(newest.created_at);
      if (!newestCreatedAt) throw serviceError("SIGNING_KEY_INVALID");
      const retiring = active.rows.find((candidate) => candidate.id !== newest.id);
      const row =
        retiring &&
        checkedAt.getTime() - newestCreatedAt.getTime() < JWKS_ROTATION_WARMUP_MS
          ? retiring
          : newest;
      await client.query("commit");
      transactionStarted = false;
      if (didInsert) publicJwksCache = undefined;
      return { inserted: didInsert, row };
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      if (error instanceof RemoteMcpOAuthSigningError) throw error;
      throw serviceError("SIGNING_KEY_UNAVAILABLE");
    } finally {
      client.release();
    }
  }

  async function signWithRow(row: OAuthJwkRow, payload: JWTPayload): Promise<string> {
    const publicJwk = publicJwkFromRow(row);
    const privateKey = await importPrivateKey(row, encryptionSecret);
    try {
      return await new SignJWT(payload)
        .setProtectedHeader({ alg: ALGORITHM, kid: publicJwk.kid, typ: TOKEN_TYPE })
        .sign(privateKey);
    } catch {
      throw serviceError("SIGNING_FAILED");
    }
  }

  return {
    async checkReady(): Promise<void> {
      const { row } = await ensureCurrentKey();
      await signWithRow(row, { readiness: true });
    },

    async getPublicJwks(): Promise<RemoteMcpOAuthJwksResult> {
      const requestedAt = now();
      if (!(requestedAt instanceof Date) || !Number.isFinite(requestedAt.getTime())) {
        throw serviceError("JWKS_UNAVAILABLE");
      }
      if (publicJwksCache && requestedAt.getTime() < publicJwksCache.expiresAt) {
        return cloneJwksResult(publicJwksCache.result);
      }

      publicJwksLoad ??= (async () => {
        try {
          await ensureCurrentKey();
          const checkedAt = now();
          if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) {
            throw serviceError("JWKS_UNAVAILABLE");
          }
          const result = await pool.query<OAuthPublicJwkRow>(
            `select id::text, public_key, created_at, expires_at
               from auth.oauth_jwks
              where expires_at > $1::timestamptz
              order by created_at desc, id desc`,
            [checkedAt],
          );
          if (result.rows.length === 0) throw serviceError("JWKS_UNAVAILABLE");
          const keys = result.rows.map((row) => {
            validateRowDates(row);
            return publicJwkFromRow(row);
          });
          const jwks = {
            cacheControl: `public, max-age=${JWKS_MAX_AGE_SECONDS}, must-revalidate`,
            document: { keys },
          } satisfies RemoteMcpOAuthJwksResult;
          publicJwksCache = {
            expiresAt: checkedAt.getTime() + JWKS_ORIGIN_CACHE_MS,
            result: cloneJwksResult(jwks),
          };
          return jwks;
        } catch (error) {
          if (error instanceof RemoteMcpOAuthSigningError) throw error;
          throw serviceError("JWKS_UNAVAILABLE");
        } finally {
          publicJwksLoad = undefined;
        }
      })();
      return cloneJwksResult(await publicJwksLoad);
    },

    async signAccessToken(payload: JWTPayload): Promise<string> {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw serviceError("SIGNING_FAILED");
      }
      const { row } = await ensureCurrentKey();
      return signWithRow(row, payload);
    },
  };
}
