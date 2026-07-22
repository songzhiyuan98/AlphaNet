import { Buffer } from "node:buffer";

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { loadAdminWebConfig, type EnabledAdminWebConfig } from "./admin-web-config";
import {
  AdminSessionStoreError,
  createAdminSessionStore,
  type AdminSessionStoreDynamoClient,
} from "./admin-session-store";

const now = new Date("2026-07-22T20:00:00.000Z");
const accessToken = [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "admin" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(now.valueOf() / 1_000) + 1_800,
      sub: "workforce-user",
    }),
  ).toString("base64url"),
  Buffer.from("integration-test-signature").toString("base64url"),
].join(".");

function config(): EnabledAdminWebConfig {
  const loaded = loadAdminWebConfig({
    ADMIN_WEB_DYNAMODB_ENDPOINT: "http://127.0.0.1:8000",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_WEB_LOGIN_TTL_SECONDS: "300",
    ADMIN_WEB_OIDC_CLIENT_ID: "alphanet-workforce-admin-web",
    ADMIN_WEB_OIDC_CLIENT_SECRET: "workforce-client-secret-with-32-plus-characters",
    ADMIN_WEB_OIDC_ISSUER: "http://127.0.0.1:5556/workforce",
    ADMIN_WEB_OIDC_SCOPES: "openid profile email",
    ADMIN_WEB_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
    ADMIN_WEB_SESSION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 0x44).toString("base64"),
    ADMIN_WEB_SESSION_STORE: "dynamodb",
    ADMIN_WEB_SESSION_TABLE: "alphanet-test-admin-web-sessions",
    ADMIN_WEB_SESSION_TTL_SECONDS: "3600",
    AWS_REGION: "us-west-2",
    NODE_ENV: "test",
  });
  if (!loaded.enabled) throw new Error("test configuration must be enabled");
  return loaded;
}

class FakeDynamoClient implements AdminSessionStoreDynamoClient {
  readonly commands: unknown[] = [];
  readonly items = new Map<string, Record<string, AttributeValue>>();
  failWith: unknown = null;

  async send(command: unknown): Promise<unknown> {
    await Promise.resolve();
    this.commands.push(command);
    if (this.failWith) {
      throw this.failWith instanceof Error
        ? this.failWith
        : new Error("fake dependency failure");
    }

    if (command instanceof PutItemCommand) {
      const item = command.input.Item;
      const key = item?.pk?.S;
      if (!item || !key) throw new Error("invalid fake PutItem input");
      if (this.items.has(key)) {
        const error = new Error("collision");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.items.set(key, item);
      return {};
    }

    if (command instanceof GetItemCommand) {
      const key = command.input.Key?.pk?.S;
      return { Item: key ? this.items.get(key) : undefined };
    }

    if (command instanceof DeleteItemCommand) {
      const key = command.input.Key?.pk?.S;
      const item = key ? this.items.get(key) : undefined;
      const expectedStateDigest =
        command.input.ExpressionAttributeValues?.[":state_digest"]?.S;
      if (
        !item ||
        Number(item.expires_at?.N ?? 0) <= now.valueOf() / 1_000 ||
        (expectedStateDigest !== undefined &&
          item.state_digest?.S !== expectedStateDigest)
      ) {
        const error = new Error("missing or expired");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.items.delete(key!);
      return { Attributes: item };
    }

    throw new Error("unsupported fake DynamoDB command");
  }
}

function encryptedBytes(item: Record<string, AttributeValue>): Buffer {
  return Buffer.concat([
    Buffer.from(item.nonce?.B ?? []),
    Buffer.from(item.ciphertext?.B ?? []),
    Buffer.from(item.auth_tag?.B ?? []),
  ]);
}

describe("Admin Web DynamoDB session store", () => {
  it("stores login state, nonce, PKCE verifier, and return target only as AES-GCM ciphertext", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation?status=open",
      state: "s".repeat(43),
    };

    const created = await store.createLoginTransaction(transaction);

    expect(created.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.expiresAt).toEqual(new Date(now.valueOf() + 300_000));
    expect(dynamo.commands).toHaveLength(1);
    const command = dynamo.commands[0];
    expect(command).toBeInstanceOf(PutItemCommand);
    const item = [...dynamo.items.values()][0];
    expect(item).toBeDefined();
    if (!item) throw new Error("test item was not persisted");
    expect(item.kind?.S).toBe("login");
    expect(item.schema?.S).toBe("alphanet-admin-web-store-v1");
    expect(item.pk?.S).not.toContain(created.handle);

    const serialized = encryptedBytes(item).toString("utf8");
    expect(serialized).not.toContain(transaction.codeVerifier);
    expect(serialized).not.toContain(transaction.nonce);
    expect(serialized).not.toContain(transaction.state);
    expect(serialized).not.toContain(transaction.returnTo);
  });

  it("atomically consumes a valid login transaction exactly once", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });
    const expected = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };
    const { handle } = await store.createLoginTransaction(expected);

    await expect(
      store.consumeLoginTransaction(handle, "x".repeat(43)),
    ).resolves.toBeNull();
    await expect(store.consumeLoginTransaction(handle, expected.state)).resolves.toEqual(
      expected,
    );
    await expect(
      store.consumeLoginTransaction(handle, expected.state),
    ).resolves.toBeNull();

    const consume = dynamo.commands.find(
      (command) => command instanceof DeleteItemCommand,
    );
    expect(consume).toBeInstanceOf(DeleteItemCommand);
    if (!(consume instanceof DeleteItemCommand)) {
      throw new Error("consume command was not captured");
    }
    expect(consume.input.ReturnValues).toBe("ALL_OLD");
    expect(consume.input.ConditionExpression).toContain("#expires_at > :now");
    expect(consume.input.ConditionExpression).toContain("#kind = :kind");
    expect(consume.input.ConditionExpression).toContain("#state_digest = :state_digest");
  });

  it("stores only an encrypted access token and resolves/deletes the opaque session", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });
    const tokenExpiresAt = new Date(now.valueOf() + 1_800_000);

    const created = await store.createSession({ accessToken, tokenExpiresAt });
    expect(created.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.expiresAt).toEqual(tokenExpiresAt);

    const item = [...dynamo.items.values()][0];
    expect(item).toBeDefined();
    if (!item) throw new Error("test item was not persisted");
    expect(item.kind?.S).toBe("session");
    expect(item.pk?.S).not.toContain(created.handle);
    expect(encryptedBytes(item).toString("utf8")).not.toContain(accessToken);

    await expect(store.getSession(created.handle)).resolves.toEqual({
      accessToken,
      expiresAt: tokenExpiresAt,
    });
    await store.deleteSession(created.handle);
    await expect(store.getSession(created.handle)).resolves.toBeNull();
  });

  it("rejects malformed handles without issuing a DynamoDB request", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });

    await expect(store.getSession("../../admin-token")).resolves.toBeNull();
    await expect(
      store.consumeLoginTransaction("short", "s".repeat(43)),
    ).resolves.toBeNull();
    await store.deleteSession("not-a-handle");
    expect(dynamo.commands).toEqual([]);
  });

  it("fails closed with claim-free errors for tampering and dependency failures", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });
    const created = await store.createSession({
      accessToken,
      tokenExpiresAt: new Date(now.valueOf() + 1_800_000),
    });
    const item = [...dynamo.items.values()][0];
    if (!item?.ciphertext?.B) throw new Error("test ciphertext was not persisted");
    item.ciphertext.B = Uint8Array.from(item.ciphertext.B, (byte, index) =>
      index === 0 ? byte ^ 0xff : byte,
    );

    let caught: unknown;
    try {
      await store.getSession(created.handle);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminSessionStoreError);
    expect(String(caught)).not.toContain(accessToken);
    expect(JSON.stringify(caught)).not.toContain(accessToken);

    const dependency = new FakeDynamoClient();
    const secretError = "Dynamo failed with access token secret-marker-51f8";
    dependency.failWith = new Error(secretError);
    const unavailable = createAdminSessionStore(config(), {
      dynamo: dependency,
      now: () => now,
    });
    await expect(unavailable.getSession(created.handle)).rejects.toMatchObject({
      code: "store_unavailable",
      name: "AdminSessionStoreError",
    });
    try {
      await unavailable.getSession(created.handle);
    } catch (error) {
      expect(String(error)).not.toContain(secretError);
      expect(JSON.stringify(error)).not.toContain(secretError);
    }
  });

  it("caps the session at both token and configured lifetime", async () => {
    const dynamo = new FakeDynamoClient();
    const store = createAdminSessionStore(config(), { dynamo, now: () => now });

    const created = await store.createSession({
      accessToken,
      tokenExpiresAt: new Date(now.valueOf() + 7_200_000),
    });
    expect(created.expiresAt).toEqual(new Date(now.valueOf() + 3_600_000));
  });

  it("uses injectable entropy without ever accepting a duplicate key", async () => {
    const dynamo = new FakeDynamoClient();
    const randomBytes = vi
      .fn<() => Uint8Array>()
      .mockReturnValueOnce(Buffer.alloc(32, 1))
      .mockReturnValueOnce(Buffer.alloc(12, 2))
      .mockReturnValueOnce(Buffer.alloc(32, 1))
      .mockReturnValueOnce(Buffer.alloc(12, 3))
      .mockReturnValueOnce(Buffer.alloc(32, 4))
      .mockReturnValueOnce(Buffer.alloc(12, 5));
    const store = createAdminSessionStore(config(), {
      dynamo,
      now: () => now,
      randomBytes,
    });
    const transaction = {
      codeVerifier: "v".repeat(64),
      nonce: "n".repeat(43),
      returnTo: "/admin/moderation",
      state: "s".repeat(43),
    };

    const first = await store.createLoginTransaction(transaction);
    const second = await store.createLoginTransaction(transaction);
    expect(first.handle).not.toBe(second.handle);
    expect(randomBytes).toHaveBeenCalledTimes(6);
  });
});
