import {
  verifyMcpActorContextAssertion,
  type McpActorAssertionKeyRing,
} from "@alphanet/auth";
import { describe, expect, it, vi } from "vitest";

import {
  createInternalMcpApiClient,
  INTERNAL_API_MAX_REQUEST_BYTES,
  INTERNAL_API_MAX_TIMEOUT_MILLISECONDS,
  InternalMcpApiClientError,
  type InternalApiRequestTransport,
  type InternalApiTransportRequest,
  type InternalApiTransportResponse,
} from "./internal-api-client.js";
import type { McpToolExecutionContext } from "./protocol.js";

const NOW = new Date("2033-05-18T03:33:20.000Z");
const REQUEST_ID = "40000000-0000-4000-8000-000000000004";
const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN_JTI_DIGEST = Buffer.alloc(32, 0x77).toString("base64url");
const assertionKeyRing: McpActorAssertionKeyRing = {
  currentVersion: 1,
  keys: {
    1: {
      key: new Uint8Array(32).fill(0x42),
      verificationExpiresAt: null,
    },
  },
};

function context(signal: AbortSignal = new AbortController().signal) {
  return {
    authorization: {
      clientId: "mcp-client-v1",
      credentialId: CREDENTIAL_ID,
      expiresAt: NOW.valueOf() / 1_000 + 600,
      grantId: GRANT_ID,
      resource: "https://mcp.alphanet.test/mcp",
      scopes: ["research:read", "community:read"],
      tokenJtiDigest: TOKEN_JTI_DIGEST,
    },
    requestId: REQUEST_ID,
    signal,
  } satisfies McpToolExecutionContext;
}

function jsonResponse(
  payload: unknown = { ok: true },
  overrides: Partial<InternalApiTransportResponse> = {},
): InternalApiTransportResponse {
  return {
    body: Buffer.from(JSON.stringify(payload)),
    headers: { "content-type": "application/json; charset=utf-8" },
    statusCode: 200,
    ...overrides,
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected object");
  }
  return value as Record<string, unknown>;
}

function client(
  transport: InternalApiRequestTransport,
  overrides: Partial<Parameters<typeof createInternalMcpApiClient>[0]> = {},
) {
  return createInternalMcpApiClient(
    {
      assertionKeyRing,
      baseUrl: "https://api.alphanet.internal:4443",
      servername: "api.alphanet.internal",
      tls: {
        ca: "test-ca",
        cert: "test-client-cert",
        key: "test-client-key",
      },
      ...overrides,
    },
    { now: () => NOW, transport },
  );
}

describe("internal MCP API client", () => {
  it("sends one fixed-origin mTLS request with only allowlisted identity headers", async () => {
    let captured: InternalApiTransportRequest | undefined;
    const transport = vi.fn<InternalApiRequestTransport>((request) => {
      captured = request;
      return Promise.resolve(jsonResponse({ agent_id: "agent-1" }));
    });
    const executionContext = context();
    Object.assign(executionContext.authorization, {
      authorization: "Bearer external-secret",
      cookie: "owner-session=external-secret",
      xForwardedFor: "203.0.113.10",
    });

    const response = await client(transport).request(
      {
        body: { include: "policy" },
        method: "POST",
        parseResponse: parseObject,
        path: "/internal/mcp/v1/agent/context?view=current",
      },
      executionContext,
    );

    expect(response).toEqual({
      payload: { agent_id: "agent-1" },
      statusCode: 200,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(captured?.url.toString()).toBe(
      "https://api.alphanet.internal:4443/internal/mcp/v1/agent/context?view=current",
    );
    expect(captured?.method).toBe("POST");
    expect(captured?.body?.toString("utf8")).toBe('{"include":"policy"}');
    expect(captured?.headers).toMatchObject({
      accept: "application/json",
      "content-length": "20",
      "content-type": "application/json",
      "x-request-id": REQUEST_ID,
    });
    expect(Object.keys(captured?.headers ?? {}).sort()).toEqual([
      "accept",
      "content-length",
      "content-type",
      "x-alphanet-mcp-actor-context",
      "x-request-id",
    ]);
    expect(JSON.stringify(captured?.headers)).not.toContain("external-secret");
    expect(captured?.tls).toEqual({
      ca: "test-ca",
      cert: "test-client-cert",
      key: "test-client-key",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: "api.alphanet.internal",
    });
    expect(captured?.timeoutMilliseconds).toBe(5_000);

    const assertion = captured?.headers["x-alphanet-mcp-actor-context"];
    expect(assertion).toBeTypeOf("string");
    await expect(
      verifyMcpActorContextAssertion(assertion ?? "", assertionKeyRing, NOW),
    ).resolves.toMatchObject({
      credentialId: CREDENTIAL_ID,
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      scopes: ["research:read", "community:read"],
      tokenJtiDigest: TOKEN_JTI_DIGEST,
    });
  });

  it("signs a fresh ActorContext assertion and JTI for every request", async () => {
    const requests: InternalApiTransportRequest[] = [];
    const transport: InternalApiRequestTransport = (request) => {
      requests.push(request);
      return Promise.resolve(jsonResponse());
    };
    const instance = client(transport);
    const executionContext = context();
    const specification = {
      method: "GET" as const,
      parseResponse: parseObject,
      path: "/internal/mcp/v1/agent/context",
    };

    await instance.request(specification, executionContext);
    await instance.request(specification, executionContext);

    const assertions = requests.map(
      (request) => request.headers["x-alphanet-mcp-actor-context"],
    );
    expect(assertions[0]).not.toBe(assertions[1]);
    const verified = await Promise.all(
      assertions.map((assertion) =>
        verifyMcpActorContextAssertion(assertion ?? "", assertionKeyRing, NOW),
      ),
    );
    expect(verified[0]?.jti).not.toBe(verified[1]?.jti);
    expect(verified.map((value) => value.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it("never lets an ActorContext assertion outlive the verified Access Token", async () => {
    let captured: InternalApiTransportRequest | undefined;
    const transport: InternalApiRequestTransport = (request) => {
      captured = request;
      return Promise.resolve(jsonResponse());
    };
    const executionContext = context();
    executionContext.authorization.expiresAt = NOW.valueOf() / 1_000 + 5;

    await client(transport).request(
      {
        method: "GET",
        parseResponse: parseObject,
        path: "/internal/mcp/v1/agent/context",
      },
      executionContext,
    );

    const assertion = captured?.headers["x-alphanet-mcp-actor-context"] ?? "";
    const verified = await verifyMcpActorContextAssertion(
      assertion,
      assertionKeyRing,
      NOW,
    );
    expect(verified.expiresAt.valueOf()).toBe(NOW.valueOf() + 5_000);
  });

  it("returns parsed non-redirect HTTP error contracts for the tool adapter to handle", async () => {
    const transport: InternalApiRequestTransport = () =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "AUTHORITY_REVOKED" }, schema_version: "1" },
          { statusCode: 401 },
        ),
      );

    await expect(
      client(transport).request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      ),
    ).resolves.toEqual({
      payload: { error: { code: "AUTHORITY_REVOKED" }, schema_version: "1" },
      statusCode: 401,
    });
  });

  it("enforces the timeout below the assertion TTL and aborts an ignoring transport", async () => {
    let transportSignal: AbortSignal | undefined;
    const transport: InternalApiRequestTransport = (request) => {
      transportSignal = request.signal;
      return new Promise(() => undefined);
    };
    const instance = client(transport, { timeoutMilliseconds: 10 });

    await expect(
      instance.request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(transportSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation without invoking a pre-aborted request", async () => {
    const transport = vi.fn<InternalApiRequestTransport>(() =>
      Promise.resolve(jsonResponse()),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      client(transport).request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(controller.signal),
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not miss cancellation that happens while the assertion is being prepared", async () => {
    const transport = vi.fn<InternalApiRequestTransport>(() =>
      Promise.resolve(jsonResponse()),
    );
    const controller = new AbortController();
    const instance = createInternalMcpApiClient(
      {
        assertionKeyRing,
        baseUrl: "https://api.alphanet.internal:4443",
        tls: { ca: "ca", cert: "cert", key: "key" },
      },
      {
        now: () => {
          controller.abort();
          return NOW;
        },
        transport,
      },
    );

    await expect(
      instance.request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(controller.signal),
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects oversized injected responses even if a custom transport ignores the limit", async () => {
    const transport: InternalApiRequestTransport = () =>
      Promise.resolve(
        jsonResponse(undefined, {
          body: Buffer.from('{"value":"0123456789"}'),
        }),
      );

    await expect(
      client(transport, { maxResponseBytes: 16 }).request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("never follows redirects or exposes redirect targets", async () => {
    const sensitiveLocation = "https://attacker.test/capture?secret=value";
    const parser = vi.fn(parseObject);
    const transport = vi.fn<InternalApiRequestTransport>(() =>
      Promise.resolve(
        jsonResponse(
          { moved: true },
          {
            headers: {
              "content-type": "application/json",
              location: sensitiveLocation,
            },
            statusCode: 302,
          },
        ),
      ),
    );
    const promise = client(transport).request(
      {
        method: "GET",
        parseResponse: parser,
        path: "/internal/mcp/v1/agent/context",
      },
      context(),
    );

    const error: unknown = await promise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalMcpApiClientError);
    expect(error).toMatchObject({ code: "REDIRECT_REJECTED" });
    expect(String(error)).not.toContain(sensitiveLocation);
    expect(transport).toHaveBeenCalledOnce();
    expect(parser).not.toHaveBeenCalled();
  });

  it.each([
    [
      "non-JSON content type",
      jsonResponse(undefined, { headers: { "content-type": "text/plain" } }),
    ],
    [
      "compressed response",
      jsonResponse(undefined, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
      }),
    ],
    ["invalid UTF-8", jsonResponse(undefined, { body: Buffer.from([0xff]) })],
    ["malformed JSON", jsonResponse(undefined, { body: Buffer.from("{") })],
    [
      "mismatched content length",
      jsonResponse(undefined, {
        headers: {
          "content-length": "999",
          "content-type": "application/json",
        },
      }),
    ],
  ])("maps %s to the fixed invalid-response boundary", async (_label, response) => {
    const transport: InternalApiRequestTransport = () => Promise.resolve(response);
    await expect(
      client(transport).request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      ),
    ).rejects.toEqual(new InternalMcpApiClientError("INVALID_RESPONSE"));
  });

  it("does not expose response data or parser diagnostics", async () => {
    const sensitive = "upstream-private-detail";
    const transport: InternalApiRequestTransport = () =>
      Promise.resolve(jsonResponse({ sensitive }));
    const error: unknown = await client(transport)
      .request(
        {
          method: "GET",
          parseResponse: () => {
            throw new Error(`contract rejected ${sensitive}`);
          },
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      )
      .catch((value: unknown) => value);

    expect(error).toEqual(new InternalMcpApiClientError("INVALID_RESPONSE"));
    expect(String(error)).not.toContain(sensitive);
  });

  it("rejects origin escapes, non-canonical paths, GET bodies, and oversized writes before transport", async () => {
    const transport = vi.fn<InternalApiRequestTransport>(() =>
      Promise.resolve(jsonResponse()),
    );
    const instance = client(transport);
    const invalidRequests = [
      {
        method: "GET" as const,
        parseResponse: parseObject,
        path: "https://attacker.test/internal/mcp/v1/agent/context",
      },
      {
        method: "GET" as const,
        parseResponse: parseObject,
        path: "/internal/mcp/v1/../owner/secrets",
      },
      {
        body: { forbidden: true },
        method: "GET" as const,
        parseResponse: parseObject,
        path: "/internal/mcp/v1/agent/context",
      },
      {
        body: { value: "x".repeat(INTERNAL_API_MAX_REQUEST_BYTES) },
        method: "POST" as const,
        parseResponse: parseObject,
        path: "/internal/mcp/v1/posts",
      },
      {
        body: "not-an-object",
        method: "POST" as const,
        parseResponse: parseObject,
        path: "/internal/mcp/v1/posts",
      },
    ];

    for (const specification of invalidRequests) {
      await expect(instance.request(specification, context())).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts only HTTPS fixed-base configuration and bounded TLS/time settings", () => {
    const transport: InternalApiRequestTransport = () => Promise.resolve(jsonResponse());
    const configuration = {
      assertionKeyRing,
      baseUrl: "http://api.alphanet.internal:4443",
      tls: { ca: "ca", cert: "cert", key: "key" },
    };

    expect(() => createInternalMcpApiClient(configuration, { transport })).toThrow(
      new InternalMcpApiClientError("CONFIGURATION_INVALID"),
    );
    expect(() =>
      client(transport, {
        timeoutMilliseconds: INTERNAL_API_MAX_TIMEOUT_MILLISECONDS + 1,
      }),
    ).toThrow(new InternalMcpApiClientError("CONFIGURATION_INVALID"));
    expect(() =>
      client(transport, { tls: { ca: "", cert: "cert", key: "key" } }),
    ).toThrow(new InternalMcpApiClientError("CONFIGURATION_INVALID"));
  });

  it("maps opaque transport failures without leaking their message", async () => {
    const sensitive = "certificate-private-key-detail";
    const transport: InternalApiRequestTransport = () =>
      Promise.reject(new Error(sensitive));
    const error: unknown = await client(transport)
      .request(
        {
          method: "GET",
          parseResponse: parseObject,
          path: "/internal/mcp/v1/agent/context",
        },
        context(),
      )
      .catch((value: unknown) => value);

    expect(error).toEqual(new InternalMcpApiClientError("TRANSPORT_UNAVAILABLE"));
    expect(String(error)).not.toContain(sensitive);
  });
});
