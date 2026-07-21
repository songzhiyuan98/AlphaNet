import { describe, expect, it } from "vitest";

import { createRedisDependency } from "./index.js";

describe("Redis dependency", () => {
  it("derives TLS and RBAC credentials from an ElastiCache rediss URL", async () => {
    const dependency = createRedisDependency(
      "rediss://alphanet-runtime:cache-secret@primary.example.cache.amazonaws.com:6379/0",
    );

    expect(dependency.client.options.host).toBe("primary.example.cache.amazonaws.com");
    expect(dependency.client.options.port).toBe(6379);
    expect(dependency.client.options.username).toBe("alphanet-runtime");
    expect(dependency.client.options.password).toBe("cache-secret");
    expect(dependency.client.options.tls).toBe(true);

    await dependency.close();
  });
});
