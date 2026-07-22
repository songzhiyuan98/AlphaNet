import {
  createMcpActorContextAssertion,
  digestInboundMcpTokenJti,
  type McpActorAssertionKeyRing,
  type McpActorAssertionReplayStore,
} from "@alphanet/auth";
import {
  AgentConnectionError,
  type AgentCredentialContext,
  type RemoteMcpAuthorityService,
} from "@alphanet/domain";
import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  createRemoteMcpActorAuthenticator,
  REMOTE_MCP_ACTOR_ASSERTION_MAX_BYTES,
  RemoteMcpActorAuthenticationError,
} from "./mcp-actor-authenticator.js";

const now = new Date("2026-07-22T12:00:00.000Z");
const ids = {
  actor: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  credential: "00000000-0000-4000-8000-000000000003",
  owner: "00000000-0000-4000-8000-000000000004",
  policy: "00000000-0000-4000-8000-000000000005",
  grant: "00000000-0000-4000-8000-000000000006",
} as const;
const assertionKeyRing: McpActorAssertionKeyRing = {
  currentVersion: 1,
  keys: {
    1: {
      key: new TextEncoder().encode("actor-context-signing-key-for-tests-v1"),
      verificationExpiresAt: null,
    },
  },
};
const tokenJtiDigest = digestInboundMcpTokenJti(
  "mcp-access-token-jti",
  new TextEncoder().encode("token-jti-digest-key-for-tests-v1!"),
);

const authorityContext = {
  agent: {
    id: ids.agent,
    actorId: ids.actor,
    ownerId: ids.owner,
    handle: "market-scout",
    displayName: "Market Scout",
    bio: null,
    discoveryTags: ["semiconductors"],
    status: "active",
    restrictionReasonCode: null,
    credentialCount: 1,
    createdAt: now,
    updatedAt: now,
    activatedAt: now,
    archivedAt: null,
    policy: {
      id: ids.policy,
      tier: "assisted",
      defaultsVersion: "agent-permission-defaults-v1",
      schemaVersion: 1,
      version: "1",
      effectiveFrom: now,
      rules: { operations: {} },
    },
  },
  credential: {
    id: ids.credential,
    ownerId: ids.owner,
    agentId: ids.agent,
    name: "Remote MCP grant",
    type: "oauth_grant",
    prefix: null,
    scopes: ["research:read", "community:read"],
    audience: "https://mcp.alphanet.test/mcp",
    policyCeiling: "assisted",
    policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
    policyCeilingRules: { operations: {} },
    policyCeilingSchemaVersion: 1,
    issuedAt: now,
    expiresAt: new Date(now.valueOf() + 86_400_000),
    lastUsedAt: null,
    revokedAt: null,
    replacesCredentialId: null,
    status: "active",
  },
  owner: { id: ids.owner },
} satisfies AgentCredentialContext;

type ReplayStoreMock = McpActorAssertionReplayStore & {
  consume: MockedFunction<McpActorAssertionReplayStore["consume"]>;
};
type AuthorityMock = Pick<RemoteMcpAuthorityService, "authenticateActorContext"> & {
  authenticateActorContext: MockedFunction<
    RemoteMcpAuthorityService["authenticateActorContext"]
  >;
};

let replayStore: ReplayStoreMock;
let authority: AuthorityMock;

beforeEach(() => {
  replayStore = {
    consume: vi.fn<McpActorAssertionReplayStore["consume"]>(() => Promise.resolve(true)),
  };
  authority = {
    authenticateActorContext: vi.fn<
      RemoteMcpAuthorityService["authenticateActorContext"]
    >(() => Promise.resolve(authorityContext)),
  };
});

async function assertion(options?: {
  issuedAt?: Date;
  requestId?: string;
  ttlSeconds?: number;
}): Promise<string> {
  return createMcpActorContextAssertion(
    {
      credentialId: ids.credential,
      grantId: ids.grant,
      requestId: options?.requestId ?? "request-1",
      scopes: ["research:read", "community:read"],
      tokenJtiDigest,
    },
    assertionKeyRing,
    {
      now: options?.issuedAt ?? now,
      ...(options?.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    },
  );
}

function authenticator(options?: {
  clock?: () => Date;
  keyRing?: McpActorAssertionKeyRing;
}) {
  return createRemoteMcpActorAuthenticator({
    authority,
    keyRing: options?.keyRing ?? assertionKeyRing,
    now: options?.clock ?? (() => now),
    replayStore,
  });
}

async function expectAuthenticationError(
  promise: Promise<unknown>,
  expected: {
    code:
      | "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED"
      | "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE";
    message: string;
    retryable: boolean;
    statusCode: number;
  },
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RemoteMcpActorAuthenticationError);
  expect(error).toMatchObject(expected);
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
}

describe("Remote MCP ActorContext authenticator", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["single-element array", ["assertion"]],
    ["duplicate array", ["first", "second"]],
    ["empty", ""],
    ["leading whitespace", " assertion"],
    ["trailing whitespace", "assertion "],
    ["over the byte limit", "a".repeat(REMOTE_MCP_ACTOR_ASSERTION_MAX_BYTES + 1)],
  ])("rejects a %s assertion without consulting dependencies", async (_label, value) => {
    await expectAuthenticationError(
      authenticator().authenticate({ assertion: value, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps expired assertions to one non-diagnostic authentication failure", async () => {
    const expired = await assertion({
      issuedAt: new Date(now.valueOf() - 10_000),
      ttlSeconds: 5,
    });

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: expired, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps a tampered signature to the same non-diagnostic authentication failure", async () => {
    const signed = await assertion();
    const segments = signed.split(".");
    const signature = segments[2]!;
    const tampered = `${segments[0]}.${segments[1]}.${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: tampered, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["array-valued", ["request-1"]],
    ["empty", ""],
    ["over the UTF-8 byte limit", "é".repeat(101)],
  ])("rejects a %s request ID before verification", async (_label, requestId) => {
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("binds request_id exactly before consuming replay state", async () => {
    const signed = await assertion({ requestId: "request-1" });

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "REQUEST-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("rejects replay before current authority is consulted", async () => {
    replayStore.consume.mockResolvedValue(false);
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).toHaveBeenCalledTimes(1);
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("fails closed when the replay store violates its boolean contract", async () => {
    replayStore.consume.mockImplementation(() =>
      Promise.resolve("denied" as unknown as boolean),
    );
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps an authority rejection to the same non-diagnostic authentication failure", async () => {
    authority.authenticateActorContext.mockRejectedValue(
      new AgentConnectionError("INVALID_CREDENTIAL"),
    );
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED",
        message: "Remote MCP ActorContext authentication failed.",
        retryable: false,
        statusCode: 401,
      },
    );
    expect(replayStore.consume).toHaveBeenCalledTimes(1);
    expect(authority.authenticateActorContext).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a replay-store outage as temporarily unavailable", async () => {
    replayStore.consume.mockRejectedValue(new Error("redis unavailable"));
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("distinguishes an unknown authority dependency failure as temporarily unavailable", async () => {
    authority.authenticateActorContext.mockRejectedValue(
      new Error("postgres unavailable"),
    );
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator().authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
  });

  it("returns the live authority context after exact ordered verification", async () => {
    const order: string[] = [];
    replayStore.consume.mockImplementation(() => {
      order.push("replay");
      return Promise.resolve(true);
    });
    authority.authenticateActorContext.mockImplementation(() => {
      order.push("authority");
      return Promise.resolve(authorityContext);
    });
    const signed = await assertion();

    const result = await authenticator().authenticate({
      assertion: signed,
      requestId: "request-1",
    });

    expect(result).toBe(authorityContext);
    expect(order).toEqual(["replay", "authority"]);
    expect(replayStore.consume).toHaveBeenCalledTimes(1);
    const [consumedJti, consumedExpiry, consumedAt] = replayStore.consume.mock.calls[0]!;
    expect(consumedJti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(consumedExpiry).toEqual(new Date(now.valueOf() + 30_000));
    expect(consumedAt).toEqual(now);
    expect(authority.authenticateActorContext).toHaveBeenCalledWith({
      credentialId: ids.credential,
      grantId: ids.grant,
      scopes: ["research:read", "community:read"],
      tokenJtiDigest,
    });
    expect(authority.authenticateActorContext).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the authenticator clock is unavailable", async () => {
    const signed = await assertion();

    await expectAuthenticationError(
      authenticator({
        clock: () => {
          throw new Error("clock unavailable");
        },
      }).authenticate({ assertion: signed, requestId: "request-1" }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps an unknown verifier failure to temporarily unavailable", async () => {
    const signed = await assertion();
    const brokenKeyRing = new Proxy(assertionKeyRing, {
      get() {
        throw new Error("key provider unavailable");
      },
    });

    await expectAuthenticationError(
      authenticator({ keyRing: brokenKeyRing }).authenticate({
        assertion: signed,
        requestId: "request-1",
      }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });

  it("maps an invalid server key ring to temporarily unavailable", async () => {
    const signed = await assertion();
    const invalidKeyRing: McpActorAssertionKeyRing = {
      currentVersion: 1,
      keys: {
        1: {
          key: new Uint8Array(8),
          verificationExpiresAt: null,
        },
      },
    };

    await expectAuthenticationError(
      authenticator({ keyRing: invalidKeyRing }).authenticate({
        assertion: signed,
        requestId: "request-1",
      }),
      {
        code: "REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE",
        message: "Remote MCP ActorContext authentication is temporarily unavailable.",
        retryable: true,
        statusCode: 503,
      },
    );
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(authority.authenticateActorContext).not.toHaveBeenCalled();
  });
});
