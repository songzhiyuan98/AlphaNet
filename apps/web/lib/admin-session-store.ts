import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import type { EnabledAdminWebConfig } from "./admin-web-config";

const STORE_SCHEMA = "alphanet-admin-web-store-v1";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OIDC_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ACCESS_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}$/;
const AUTH_TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_CREATE_ATTEMPTS = 3;

type StoredKind = "login" | "session";
type AdminSessionStoreCommand = PutItemCommand | GetItemCommand | DeleteItemCommand;

export interface AdminSessionStoreDynamoClient {
  send(command: AdminSessionStoreCommand): Promise<unknown>;
}

export interface AdminLoginTransaction {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  state: string;
}

export interface AdminWebSession {
  accessToken: string;
  expiresAt: Date;
}

export interface AdminSessionStore {
  createLoginTransaction(transaction: AdminLoginTransaction): Promise<{
    expiresAt: Date;
    handle: string;
  }>;
  consumeLoginTransaction(
    handle: string,
    expectedState: string,
  ): Promise<AdminLoginTransaction | null>;
  createSession(input: {
    accessToken: string;
    tokenExpiresAt: Date;
  }): Promise<{ expiresAt: Date; handle: string }>;
  deleteSession(handle: string): Promise<void>;
  getSession(handle: string): Promise<AdminWebSession | null>;
}

export type AdminSessionStoreFailure = "corrupt_record" | "store_unavailable";

export class AdminSessionStoreError extends Error {
  readonly code: AdminSessionStoreFailure;

  constructor(code: AdminSessionStoreFailure) {
    super(
      code === "corrupt_record"
        ? "The Admin session record is invalid."
        : "The Admin session store is unavailable.",
    );
    this.name = "AdminSessionStoreError";
    this.code = code;
  }
}

export interface AdminSessionStoreDependencies {
  dynamo?: AdminSessionStoreDynamoClient | undefined;
  now?: (() => Date) | undefined;
  randomBytes?: ((size: number) => Uint8Array) | undefined;
}

interface EncryptedItem {
  authTag: Uint8Array;
  ciphertext: Uint8Array;
  expiresAtSeconds: number;
  kind: StoredKind;
  nonce: Uint8Array;
  partitionKey: string;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resultAttributes(
  result: unknown,
  key: "Attributes" | "Item",
): Record<string, AttributeValue> | undefined {
  if (!isObject(result)) return undefined;
  const value = result[key];
  return isObject(value) ? (value as Record<string, AttributeValue>) : undefined;
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.trim() === value
  );
}

function validLoginTransaction(value: unknown): value is AdminLoginTransaction {
  if (!isObject(value)) return false;
  return (
    typeof value.codeVerifier === "string" &&
    OIDC_SECRET_PATTERN.test(value.codeVerifier) &&
    typeof value.nonce === "string" &&
    OIDC_SECRET_PATTERN.test(value.nonce) &&
    typeof value.state === "string" &&
    OIDC_SECRET_PATTERN.test(value.state) &&
    boundedString(value.returnTo, 6, 2_048) &&
    (value.returnTo === "/admin" || value.returnTo.startsWith("/admin/"))
  );
}

function validAccessToken(value: unknown): value is string {
  return typeof value === "string" && ACCESS_TOKEN_PATTERN.test(value);
}

function binaryAttribute(
  item: Record<string, AttributeValue>,
  name: string,
  expectedLength?: number,
): Uint8Array | null {
  const value = item[name]?.B;
  if (!(value instanceof Uint8Array)) return null;
  if (expectedLength !== undefined && value.byteLength !== expectedLength) return null;
  return Uint8Array.from(value);
}

function parseEncryptedItem(
  item: Record<string, AttributeValue>,
  expectedKind: StoredKind,
  expectedPartitionKey: string,
): EncryptedItem {
  const partitionKey = item.pk?.S;
  const kind = item.kind?.S;
  const schema = item.schema?.S;
  const expiresAtRaw = item.expires_at?.N;
  const keyVersion = item.key_version?.N;
  const nonce = binaryAttribute(item, "nonce", NONCE_BYTES);
  const ciphertext = binaryAttribute(item, "ciphertext");
  const authTag = binaryAttribute(item, "auth_tag", AUTH_TAG_BYTES);
  const expiresAtSeconds = Number(expiresAtRaw);
  if (
    partitionKey !== expectedPartitionKey ||
    kind !== expectedKind ||
    schema !== STORE_SCHEMA ||
    keyVersion !== "1" ||
    !Number.isInteger(expiresAtSeconds) ||
    expiresAtSeconds < 1 ||
    !nonce ||
    !ciphertext ||
    ciphertext.byteLength < 1 ||
    ciphertext.byteLength > 32_768 ||
    !authTag
  ) {
    throw new AdminSessionStoreError("corrupt_record");
  }
  return {
    authTag,
    ciphertext,
    expiresAtSeconds,
    kind: expectedKind,
    nonce,
    partitionKey,
  };
}

function storeFingerprint(config: EnabledAdminWebConfig): string {
  return createHash("sha256")
    .update(
      [
        config.awsRegion,
        config.dynamodbEndpoint ?? "aws-default",
        config.sessionTable,
        Buffer.from(config.sessionEncryptionKey).toString("base64"),
      ].join("\n"),
    )
    .digest("base64url");
}

function createDefaultDynamoClient(
  config: EnabledAdminWebConfig,
): AdminSessionStoreDynamoClient {
  const client = new DynamoDBClient({
    region: config.awsRegion,
    ...(config.dynamodbEndpoint ? { endpoint: config.dynamodbEndpoint } : {}),
  });
  return {
    send: (command) => {
      if (command instanceof PutItemCommand) return client.send(command);
      if (command instanceof GetItemCommand) return client.send(command);
      return client.send(command);
    },
  };
}

export function createAdminSessionStore(
  config: EnabledAdminWebConfig,
  dependencies: AdminSessionStoreDependencies = {},
): AdminSessionStore {
  if (config.sessionStore !== "dynamodb") {
    throw new AdminSessionStoreError("store_unavailable");
  }
  const dynamo = dependencies.dynamo ?? createDefaultDynamoClient(config);
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const masterKey = Buffer.from(config.sessionEncryptionKey);
  const encryptionKey = Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(STORE_SCHEMA),
      Buffer.from("aes-256-gcm-encryption-v1"),
      32,
    ),
  );
  const lookupKey = Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(STORE_SCHEMA),
      Buffer.from("opaque-handle-lookup-v1"),
      32,
    ),
  );
  masterKey.fill(0);

  function partitionKey(kind: StoredKind, handle: string): string {
    const digest = createHmac("sha256", lookupKey)
      .update(`${kind}\n${handle}`)
      .digest("base64url");
    return `admin-web#${kind}#${digest}`;
  }

  function aad(kind: StoredKind, key: string, expiresAtSeconds: number): Buffer {
    return Buffer.from(`${STORE_SCHEMA}\n${kind}\n${key}\n${expiresAtSeconds}`);
  }

  function stateDigest(state: string): string {
    return createHmac("sha256", lookupKey)
      .update(`login-state\n${state}`)
      .digest("base64url");
  }

  function encrypt(
    kind: StoredKind,
    key: string,
    expiresAtSeconds: number,
    payload: unknown,
  ): Pick<EncryptedItem, "authTag" | "ciphertext" | "nonce"> {
    try {
      const nonce = Uint8Array.from(randomBytes(NONCE_BYTES));
      if (nonce.byteLength !== NONCE_BYTES) {
        throw new Error("invalid entropy length");
      }
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad(kind, key, expiresAtSeconds));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      return {
        authTag: Uint8Array.from(cipher.getAuthTag()),
        ciphertext: Uint8Array.from(ciphertext),
        nonce,
      };
    } catch {
      throw new AdminSessionStoreError("corrupt_record");
    }
  }

  function decrypt(item: EncryptedItem): unknown {
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, item.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad(item.kind, item.partitionKey, item.expiresAtSeconds));
      decipher.setAuthTag(item.authTag);
      const plaintext = Buffer.concat([
        decipher.update(item.ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new AdminSessionStoreError("corrupt_record");
    }
  }

  async function putEncrypted(
    kind: StoredKind,
    expiresAtSeconds: number,
    payload: unknown,
    additionalAttributes: Record<string, AttributeValue> = {},
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const handleBytes = Uint8Array.from(randomBytes(32));
      if (handleBytes.byteLength !== 32) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      const handle = Buffer.from(handleBytes).toString("base64url");
      const key = partitionKey(kind, handle);
      const encrypted = encrypt(kind, key, expiresAtSeconds, payload);
      try {
        await dynamo.send(
          new PutItemCommand({
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
            Item: {
              auth_tag: { B: encrypted.authTag },
              ciphertext: { B: encrypted.ciphertext },
              expires_at: { N: String(expiresAtSeconds) },
              key_version: { N: "1" },
              kind: { S: kind },
              nonce: { B: encrypted.nonce },
              pk: { S: key },
              schema: { S: STORE_SCHEMA },
              ...additionalAttributes,
            },
            TableName: config.sessionTable,
          }),
        );
        return handle;
      } catch (error) {
        if (isConditionalFailure(error)) continue;
        throw new AdminSessionStoreError("store_unavailable");
      }
    }
    throw new AdminSessionStoreError("store_unavailable");
  }

  async function getEncrypted(
    kind: StoredKind,
    handle: string,
  ): Promise<EncryptedItem | null> {
    if (!HANDLE_PATTERN.test(handle)) return null;
    const key = partitionKey(kind, handle);
    try {
      const result = await dynamo.send(
        new GetItemCommand({
          ConsistentRead: true,
          Key: { pk: { S: key } },
          ProjectionExpression:
            "pk, #kind, #schema, expires_at, key_version, nonce, ciphertext, auth_tag",
          ExpressionAttributeNames: {
            "#kind": "kind",
            "#schema": "schema",
          },
          TableName: config.sessionTable,
        }),
      );
      const item = resultAttributes(result, "Item");
      if (!item) return null;
      const parsed = parseEncryptedItem(item, kind, key);
      return parsed.expiresAtSeconds <= Math.floor(now().valueOf() / 1_000)
        ? null
        : parsed;
    } catch (error) {
      if (error instanceof AdminSessionStoreError) throw error;
      throw new AdminSessionStoreError("store_unavailable");
    }
  }

  const store: AdminSessionStore = {
    createLoginTransaction: async (transaction) => {
      if (!validLoginTransaction(transaction)) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      const expiresAtSeconds =
        Math.floor(now().valueOf() / 1_000) + config.loginTtlSeconds;
      const handle = await putEncrypted("login", expiresAtSeconds, transaction, {
        state_digest: { S: stateDigest(transaction.state) },
      });
      return {
        expiresAt: new Date(expiresAtSeconds * 1_000),
        handle,
      };
    },
    consumeLoginTransaction: async (handle, expectedState) => {
      if (!HANDLE_PATTERN.test(handle) || !OIDC_SECRET_PATTERN.test(expectedState)) {
        return null;
      }
      const key = partitionKey("login", handle);
      const nowSeconds = Math.floor(now().valueOf() / 1_000);
      let result: unknown;
      try {
        result = await dynamo.send(
          new DeleteItemCommand({
            ConditionExpression:
              "attribute_exists(#pk) AND #kind = :kind AND #expires_at > :now AND #state_digest = :state_digest",
            ExpressionAttributeNames: {
              "#expires_at": "expires_at",
              "#kind": "kind",
              "#pk": "pk",
              "#state_digest": "state_digest",
            },
            ExpressionAttributeValues: {
              ":kind": { S: "login" },
              ":now": { N: String(nowSeconds) },
              ":state_digest": { S: stateDigest(expectedState) },
            },
            Key: { pk: { S: key } },
            ReturnValues: "ALL_OLD",
            TableName: config.sessionTable,
          }),
        );
      } catch (error) {
        if (isConditionalFailure(error)) return null;
        throw new AdminSessionStoreError("store_unavailable");
      }
      const attributes = resultAttributes(result, "Attributes");
      if (!attributes) throw new AdminSessionStoreError("corrupt_record");
      const payload = decrypt(parseEncryptedItem(attributes, "login", key));
      if (!validLoginTransaction(payload)) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      if (!timingSafeEqual(Buffer.from(payload.state), Buffer.from(expectedState))) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      return Object.freeze({ ...payload });
    },
    createSession: async ({ accessToken, tokenExpiresAt }) => {
      const nowValue = now().valueOf();
      if (
        !validAccessToken(accessToken) ||
        !(tokenExpiresAt instanceof Date) ||
        !Number.isFinite(tokenExpiresAt.valueOf()) ||
        tokenExpiresAt.valueOf() <= nowValue
      ) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      const configuredExpiry = nowValue + config.sessionTtlSeconds * 1_000;
      const expiresAtSeconds = Math.floor(
        Math.min(configuredExpiry, tokenExpiresAt.valueOf()) / 1_000,
      );
      if (expiresAtSeconds <= Math.floor(nowValue / 1_000)) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      const handle = await putEncrypted("session", expiresAtSeconds, {
        accessToken,
      });
      return { expiresAt: new Date(expiresAtSeconds * 1_000), handle };
    },
    deleteSession: async (handle) => {
      if (!HANDLE_PATTERN.test(handle)) return;
      try {
        await dynamo.send(
          new DeleteItemCommand({
            Key: { pk: { S: partitionKey("session", handle) } },
            TableName: config.sessionTable,
          }),
        );
      } catch {
        throw new AdminSessionStoreError("store_unavailable");
      }
    },
    getSession: async (handle) => {
      const encrypted = await getEncrypted("session", handle);
      if (!encrypted) return null;
      const payload = decrypt(encrypted);
      if (!isObject(payload) || !validAccessToken(payload.accessToken)) {
        throw new AdminSessionStoreError("corrupt_record");
      }
      return Object.freeze({
        accessToken: payload.accessToken,
        expiresAt: new Date(encrypted.expiresAtSeconds * 1_000),
      });
    },
  };
  return Object.freeze(store);
}

let cachedDefaultStore: { fingerprint: string; store: AdminSessionStore } | undefined;

export function getAdminSessionStore(config: EnabledAdminWebConfig): AdminSessionStore {
  const fingerprint = storeFingerprint(config);
  if (cachedDefaultStore?.fingerprint === fingerprint) {
    return cachedDefaultStore.store;
  }
  const store = createAdminSessionStore(config);
  cachedDefaultStore = { fingerprint, store };
  return store;
}
