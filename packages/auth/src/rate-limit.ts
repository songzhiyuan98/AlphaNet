import type { RateLimit } from "better-auth";
import type { Redis } from "ioredis";

const consumeScript = `
local key = KEYS[1]
local window_seconds = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local now_parts = redis.call("TIME")
local now_milliseconds = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local encoded = redis.call("GET", key)

if not encoded then
  local value = cjson.encode({ count = 1, lastRequest = now_milliseconds })
  redis.call("SET", key, value, "EX", window_seconds)
  return { 1, window_seconds }
end

local value = cjson.decode(encoded)
if tonumber(value.count) >= maximum then
  local ttl = redis.call("TTL", key)
  if ttl < 0 then ttl = window_seconds end
  return { 0, ttl }
end

value.count = tonumber(value.count) + 1
redis.call("SET", key, cjson.encode(value), "KEEPTTL")
local ttl = redis.call("TTL", key)
if ttl < 0 then ttl = window_seconds end
return { 1, ttl }
`;

function isRateLimit(value: unknown): value is RateLimit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<RateLimit>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.count === "number" &&
    Number.isFinite(candidate.count) &&
    typeof candidate.lastRequest === "number" &&
    Number.isFinite(candidate.lastRequest)
  );
}

export class RedisRateLimitStorage {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = "alphanet:better-auth:rate-limit:",
  ) {}

  async get(key: string): Promise<RateLimit | null> {
    const value = await this.redis.get(`${this.keyPrefix}${key}`);
    if (!value) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(value);
      return isRateLimit(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: RateLimit): Promise<void> {
    await this.redis.set(`${this.keyPrefix}${key}`, JSON.stringify(value), "EX", 86_400);
  }

  async consume(
    key: string,
    rule: { max: number; window: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }> {
    const result = await this.redis.eval(
      consumeScript,
      1,
      `${this.keyPrefix}${key}`,
      rule.window,
      rule.max,
    );
    if (
      !Array.isArray(result) ||
      typeof result[0] !== "number" ||
      typeof result[1] !== "number"
    ) {
      throw new Error("Redis returned an invalid auth rate-limit result");
    }

    return {
      allowed: result[0] === 1,
      retryAfter: result[0] === 1 ? null : Math.max(1, result[1]),
    };
  }
}
