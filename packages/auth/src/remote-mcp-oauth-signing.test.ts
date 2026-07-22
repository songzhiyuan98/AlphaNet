import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  createAlphaNetRemoteMcpOAuthSigningService,
  RemoteMcpOAuthSigningError,
} from "./remote-mcp-oauth-signing.js";

const JWK_ENCRYPTION_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ENCRYPTION_SECRET = Buffer.from(JWK_ENCRYPTION_KEY).toString("base64url");
const NOW = new Date("2026-07-22T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

interface StoredRow {
  created_at: Date | string;
  expires_at: Date | string | null;
  id: string;
  private_key: string;
  public_key: string;
}

interface QueryCall {
  text: string;
  values: unknown[];
}

function normalizeSql(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function dateValue(value: unknown): number {
  if (!(value instanceof Date)) throw new Error("Expected Date query parameter");
  return value.getTime();
}

class StatefulClient {
  readonly calls: QueryCall[] = [];
  readonly #pool: StatefulPool;
  released = false;

  constructor(pool: StatefulPool) {
    this.#pool = pool;
  }

  query(text: string, values: unknown[] = []) {
    const normalized = normalizeSql(text);
    this.calls.push({ text: normalized, values: [...values] });

    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback" ||
      normalized.includes("pg_advisory_xact_lock")
    ) {
      return Promise.resolve(this.#result([]));
    }
    if (
      normalized.startsWith("select id::text") &&
      normalized.includes("from auth.oauth_jwks") &&
      normalized.includes("for update")
    ) {
      const checkedAt = dateValue(values[0]);
      const rows = this.#pool.rows
        .filter((row) => {
          const expiresAt =
            row.expires_at === null ? null : new Date(row.expires_at).getTime();
          return expiresAt !== null && expiresAt > checkedAt;
        })
        .sort((left, right) => {
          const byCreated =
            new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
          return byCreated === 0 ? right.id.localeCompare(left.id) : byCreated;
        })
        .slice(0, 3);
      return Promise.resolve(this.#result(rows));
    }
    if (normalized.startsWith("insert into auth.oauth_jwks")) {
      const row: StoredRow = {
        id: String(values[0]),
        public_key: String(values[1]),
        private_key: String(values[2]),
        created_at: values[3] as Date,
        expires_at: values[4] as Date,
      };
      this.#pool.rows.push(row);
      return Promise.resolve(this.#result([row]));
    }
    if (normalized.startsWith("update auth.oauth_jwks")) {
      const graceExpiresAt = values[0] as Date;
      const cutoff = dateValue(values[1]);
      const checkedAt = dateValue(values[2]);
      const retiring = this.#pool.rows
        .filter((row) => {
          const createdAt = new Date(row.created_at).getTime();
          const expiresAt =
            row.expires_at === null ? null : new Date(row.expires_at).getTime();
          return createdAt <= cutoff && expiresAt !== null && expiresAt > checkedAt;
        })
        .sort((left, right) => {
          const byCreated =
            new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
          return byCreated === 0 ? right.id.localeCompare(left.id) : byCreated;
        })[0];
      if (retiring) {
        const priorExpiry =
          retiring.expires_at === null ? null : new Date(retiring.expires_at).getTime();
        if (priorExpiry === null || priorExpiry < graceExpiresAt.getTime()) {
          retiring.expires_at = graceExpiresAt;
        }
      }
      return Promise.resolve(this.#result([]));
    }
    return Promise.reject(new Error(`Unexpected client query: ${normalized}`));
  }

  release(): void {
    this.released = true;
  }

  #result(rows: StoredRow[]) {
    return {
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: rows.length,
      rows,
    };
  }
}

class StatefulPool {
  readonly calls: QueryCall[] = [];
  readonly clients: StatefulClient[] = [];
  readonly rows: StoredRow[];

  constructor(rows: StoredRow[] = []) {
    this.rows = [...rows];
  }

  connect(): Promise<StatefulClient> {
    const client = new StatefulClient(this);
    this.clients.push(client);
    return Promise.resolve(client);
  }

  query(text: string, values: unknown[] = []) {
    const normalized = normalizeSql(text);
    this.calls.push({ text: normalized, values: [...values] });
    if (
      normalized.includes("from auth.oauth_jwks") &&
      !normalized.includes("for update")
    ) {
      const checkedAt = dateValue(values[0]);
      const rows = this.rows
        .filter((row) => {
          const expiresAt =
            row.expires_at === null ? null : new Date(row.expires_at).getTime();
          return expiresAt !== null && expiresAt > checkedAt;
        })
        .sort((left, right) => {
          const byCreated =
            new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
          return byCreated === 0 ? right.id.localeCompare(left.id) : byCreated;
        });
      return Promise.resolve({
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows,
      });
    }
    return Promise.reject(new Error(`Unexpected pool query: ${normalized}`));
  }

  asPool(): Pick<Pool, "connect" | "query"> {
    return this as unknown as Pick<Pool, "connect" | "query">;
  }
}

async function makeStoredRow(
  id: string,
  createdAt: Date,
  expiresAt: Date,
  encryptionSecret = ENCRYPTION_SECRET,
): Promise<StoredRow> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  const encrypted = await symmetricEncrypt({
    data: JSON.stringify(privateJwk),
    key: encryptionSecret,
  });
  return {
    created_at: createdAt,
    expires_at: expiresAt,
    id,
    private_key: JSON.stringify(encrypted),
    public_key: JSON.stringify(await exportJWK(publicKey)),
  };
}

function createService(pool: StatefulPool, clock: { value: Date }) {
  return createAlphaNetRemoteMcpOAuthSigningService({
    jwkEncryptionKey: JWK_ENCRYPTION_KEY,
    now: () => new Date(clock.value),
    pool: pool.asPool(),
  });
}

describe("createAlphaNetRemoteMcpOAuthSigningService", () => {
  it("requires and copies a dedicated 32-byte JWK encryption key", async () => {
    const pool = new StatefulPool();
    expect(() =>
      createAlphaNetRemoteMcpOAuthSigningService({
        jwkEncryptionKey: new Uint8Array(31),
        pool: pool.asPool(),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));

    const callerOwnedKey = new Uint8Array(JWK_ENCRYPTION_KEY);
    const service = createAlphaNetRemoteMcpOAuthSigningService({
      jwkEncryptionKey: callerOwnedKey,
      now: () => NOW,
      pool: pool.asPool(),
    });
    callerOwnedKey.fill(0);

    await expect(service.signAccessToken({ sub: "copied-key" })).resolves.toEqual(
      expect.any(String),
    );
    const encrypted = JSON.parse(pool.rows[0]?.private_key ?? "null") as string;
    await expect(
      symmetricDecrypt({ data: encrypted, key: ENCRYPTION_SECRET }),
    ).resolves.toContain('"d"');
  });

  it("creates an encrypted P-256 key and signs the exact caller payload", async () => {
    const pool = new StatefulPool();
    const clock = { value: NOW };
    const service = createService(pool, clock);
    const payload = {
      aud: "https://mcp.alphanet.example/mcp",
      custom: { verified: false },
      exp: 1_800_000_600,
      iat: 1_800_000_000,
      scope: "research:read",
      sub: "grant-id",
    };

    const token = await service.signAccessToken(payload);

    expect(decodeJwt(token)).toEqual(payload);
    const protectedHeader = decodeProtectedHeader(token);
    expect(protectedHeader).toEqual({
      alg: "ES256",
      kid: pool.rows[0]?.id,
      typ: "JWT",
    });
    expect(Object.keys(protectedHeader).sort()).toEqual(["alg", "kid", "typ"]);
    expect(pool.rows).toHaveLength(1);
    expect(pool.rows[0]?.expires_at).toEqual(new Date(NOW.getTime() + 37 * DAY_MS));
    expect(pool.rows[0]?.private_key).not.toContain('"d"');

    const encrypted = JSON.parse(pool.rows[0]?.private_key ?? "null") as unknown;
    expect(typeof encrypted).toBe("string");
    const decrypted = await symmetricDecrypt({
      key: ENCRYPTION_SECRET,
      data: encrypted as string,
    });
    expect(JSON.parse(decrypted)).toMatchObject({ crv: "P-256", kty: "EC" });
    expect(JSON.parse(decrypted)).toHaveProperty("d");
    expect(
      pool.clients[0]?.calls.some((call) => call.text.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(pool.clients[0]?.released).toBe(true);
  });

  it("prepublishes a replacement before signing and preserves a full 7-day public grace", async () => {
    const first = await makeStoredRow(
      "10000000-0000-4000-8000-000000000001",
      NOW,
      new Date(NOW.getTime() + 37 * DAY_MS),
    );
    const pool = new StatefulPool([first]);
    const clock = { value: new Date(NOW.getTime() + 29 * DAY_MS) };
    const service = createService(pool, clock);

    expect(
      decodeProtectedHeader(await service.signAccessToken({ sub: "first" })).kid,
    ).toBe(first.id);
    expect(pool.rows).toHaveLength(1);

    clock.value = new Date(NOW.getTime() + 35 * DAY_MS);
    const prepublicationToken = await service.signAccessToken({ sub: "prepublication" });
    expect(decodeProtectedHeader(prepublicationToken).kid).toBe(first.id);
    expect(pool.rows).toHaveLength(2);
    const replacementId = pool.rows.find((row) => row.id !== first.id)?.id;
    expect(replacementId).toEqual(expect.any(String));

    const prepublished = await service.getPublicJwks();
    expect(prepublished.document.keys.map((key) => key.kid)).toEqual(
      expect.arrayContaining([first.id, replacementId]),
    );

    clock.value = new Date(NOW.getTime() + 35 * DAY_MS + 10 * 60 * 1_000 - 1);
    expect(
      decodeProtectedHeader(await service.signAccessToken({ sub: "still-warming" })).kid,
    ).toBe(first.id);
    clock.value = new Date(NOW.getTime() + 35 * DAY_MS + 10 * 60 * 1_000);
    expect(
      decodeProtectedHeader(await service.signAccessToken({ sub: "rotated" })).kid,
    ).toBe(replacementId);

    clock.value = new Date(NOW.getTime() + 40 * DAY_MS);
    const duringGrace = await service.getPublicJwks();
    expect(duringGrace.cacheControl).toBe("public, max-age=300, must-revalidate");
    expect(duringGrace.document.keys.map((key) => key.kid)).toContain(first.id);
    expect(duringGrace.document.keys).toHaveLength(2);
    for (const key of duringGrace.document.keys) {
      expect(key).toEqual({
        alg: "ES256",
        crv: "P-256",
        kid: key.kid,
        kty: "EC",
        use: "sig",
        x: key.x,
        y: key.y,
      });
      expect(key.x).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(key.y).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(key).not.toHaveProperty("d");
    }

    clock.value = new Date(NOW.getTime() + 43 * DAY_MS);
    const afterGrace = await service.getPublicJwks();
    expect(afterGrace.document.keys.map((key) => key.kid)).not.toContain(first.id);
    expect(afterGrace.document.keys).toHaveLength(1);
  });

  it("coalesces concurrent JWKS loads and returns mutation-safe cached public keys", async () => {
    const current = await makeStoredRow(
      "10000000-0000-4000-8000-000000000001",
      NOW,
      new Date(NOW.getTime() + 37 * DAY_MS),
    );
    const pool = new StatefulPool([current]);
    const clock = { value: NOW };
    const service = createService(pool, clock);

    const burst = await Promise.all(
      Array.from({ length: 250 }, () => service.getPublicJwks()),
    );
    expect(pool.clients).toHaveLength(1);
    expect(pool.calls).toHaveLength(1);
    expect(burst.every((result) => result.document.keys.length === 1)).toBe(true);
    expect(burst[0]?.document.keys[0]).not.toHaveProperty("d");

    const poisoned = burst[0]?.document.keys[0];
    if (!poisoned) throw new Error("Expected cached public JWK");
    poisoned.kid = "caller-mutated";
    expect((await service.getPublicJwks()).document.keys[0]?.kid).toBe(current.id);
    expect(pool.clients).toHaveLength(1);
    expect(pool.calls).toHaveLength(1);

    clock.value = new Date(NOW.getTime() + 30_001);
    await Promise.all(Array.from({ length: 250 }, () => service.getPublicJwks()));
    expect(pool.clients).toHaveLength(2);
    expect(pool.calls).toHaveLength(2);
  });

  it("fails closed on duplicate current rows", async () => {
    const rows = await Promise.all([
      makeStoredRow(
        "10000000-0000-4000-8000-000000000001",
        new Date(NOW.getTime() - DAY_MS),
        new Date(NOW.getTime() + 36 * DAY_MS),
      ),
      makeStoredRow(
        "10000000-0000-4000-8000-000000000002",
        NOW,
        new Date(NOW.getTime() + 37 * DAY_MS),
      ),
    ]);
    const pool = new StatefulPool(rows);
    const service = createService(pool, { value: NOW });

    await expect(service.signAccessToken({ sub: "blocked" })).rejects.toMatchObject({
      code: "SIGNING_KEY_INVALID",
    });
    expect(pool.clients[0]?.calls.at(-1)?.text).toBe("rollback");
  });

  it("does not expose encrypted key material or crypto failures in errors", async () => {
    const marker = "DO-NOT-LEAK-PRIVATE-KEY-MATERIAL";
    const valid = await makeStoredRow(
      "10000000-0000-4000-8000-000000000001",
      NOW,
      new Date(NOW.getTime() + 37 * DAY_MS),
    );
    valid.private_key = JSON.stringify(marker);
    const service = createService(new StatefulPool([valid]), { value: NOW });

    let error: unknown;
    try {
      await service.signAccessToken({ sub: "blocked" });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RemoteMcpOAuthSigningError);
    expect(error).toMatchObject({ code: "SIGNING_KEY_INVALID" });
    expect(String(error)).not.toContain(marker);
    expect(error).not.toHaveProperty("cause");
  });

  it("checks readiness through the real decrypt and signing path", async () => {
    const pool = new StatefulPool();
    const service = createService(pool, { value: NOW });

    await expect(service.checkReady()).resolves.toBeUndefined();
    expect(pool.rows).toHaveLength(1);
  });
});
