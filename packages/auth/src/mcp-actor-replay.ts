import { createHmac } from "node:crypto";

import type { Redis } from "ioredis";
import { z } from "zod";

const JtiSchema = z.uuid();
const replayMaximumLifetimeMilliseconds = 35_000;

export interface McpActorAssertionReplayStore {
  consume(jti: string, expiresAt: Date, now?: Date): Promise<boolean>;
}

export interface RedisMcpActorAssertionReplayStoreOptions {
  digestKey: Uint8Array;
  keyPrefix?: string | undefined;
}

export class RedisMcpActorAssertionReplayStore implements McpActorAssertionReplayStore {
  readonly #digestKey: Uint8Array;
  readonly #keyPrefix: string;
  readonly #redis: Pick<Redis, "set">;

  constructor(
    redis: Pick<Redis, "set">,
    options: RedisMcpActorAssertionReplayStoreOptions,
  ) {
    if (options.digestKey.byteLength < 32) {
      throw new Error("MCP ActorContext replay digest key must be at least 32 bytes");
    }
    this.#redis = redis;
    this.#digestKey = options.digestKey;
    this.#keyPrefix = options.keyPrefix ?? "alphanet:mcp-actor-assertion:jti:";
  }

  async consume(jti: string, expiresAt: Date, now = new Date()): Promise<boolean> {
    JtiSchema.parse(jti);
    const lifetime = expiresAt.valueOf() - now.valueOf();
    if (lifetime <= 0 || lifetime > replayMaximumLifetimeMilliseconds) {
      return false;
    }
    const key = `${this.#keyPrefix}${createHmac("sha256", this.#digestKey)
      .update(jti, "utf8")
      .digest("base64url")}`;
    const result = await this.#redis.set(key, "1", "PX", Math.ceil(lifetime), "NX");
    return result === "OK";
  }
}
