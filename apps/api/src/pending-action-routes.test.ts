import {
  GetActionStatusResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  PendingActionStatusError,
  type AgentConnectionService,
  type AgentCredentialContext,
  type AgentPendingActionView,
  type PendingActionStatusService,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPendingActionRoutes } from "./pending-action-routes.js";

const ids = {
  action: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000001",
  agent: "30000000-0000-4000-8000-000000000001",
  credential: "40000000-0000-4000-8000-000000000001",
  owner: "50000000-0000-4000-8000-000000000001",
  policy: "60000000-0000-4000-8000-000000000001",
} as const;
const apiKey = "aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const requestedAt = new Date("2026-07-20T12:00:00.000Z");
const expiresAt = new Date("2026-07-21T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function context(
  scopes: AgentCredentialContext["credential"]["scopes"] = ["actions:read"],
): AgentCredentialContext {
  return {
    agent: {
      id: ids.agent,
      actorId: ids.actor,
      ownerId: ids.owner,
      handle: "market-scout",
      displayName: "Market Scout",
      bio: null,
      discoveryTags: [],
      status: "active",
      restrictionReasonCode: null,
      credentialCount: 1,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      activatedAt: requestedAt,
      archivedAt: null,
      policy: {
        id: ids.policy,
        tier: "assisted",
        defaultsVersion: "agent-permission-defaults-v1",
        schemaVersion: 1,
        version: "1",
        effectiveFrom: requestedAt,
      },
    },
    credential: {
      id: ids.credential,
      ownerId: ids.owner,
      agentId: ids.agent,
      name: "Research runner",
      type: "static_api_key",
      prefix: "aln_v1_abcdefghijkl",
      scopes,
      audience: "urn:alphanet:api:v1",
      policyCeiling: "assisted",
      issuedAt: requestedAt,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      replacesCredentialId: null,
      status: "active",
    },
    owner: { id: ids.owner },
  };
}

function pendingAction(): AgentPendingActionView {
  return {
    id: ids.action,
    operation: "create_post",
    decision: "require_approval",
    status: "pending_approval",
    state: "pending_approval",
    decisionId: "70000000-0000-4000-8000-000000000001",
    policyVersion: `${ids.policy}:1`,
    requestedAt,
    expiresAt,
    decidedAt: null,
    executingAt: null,
    completedAt: null,
    terminalAt: null,
    inputDigest: `sha256:${"a".repeat(64)}`,
    approvalSummary: "Create one post in the Semiconductors community.",
    approvalOutcome: null,
    approvalMethod: null,
    decidedByOwnerId: null,
    result: null,
    error: null,
  };
}

function createApp(options?: {
  action?: AgentPendingActionView;
  context?: AgentCredentialContext;
  getActionStatus?: PendingActionStatusService["getActionStatus"];
}) {
  const app = Fastify({ logger: false });
  const authenticatedContext = options?.context ?? context();
  const authenticateStaticApiKey = vi.fn<
    AgentConnectionService["authenticateStaticApiKey"]
  >(() => Promise.resolve(authenticatedContext));
  const getActionStatus = vi.fn<PendingActionStatusService["getActionStatus"]>(
    options?.getActionStatus ??
      (() => Promise.resolve(options?.action ?? pendingAction())),
  );
  registerPendingActionRoutes(app, {
    agentConnectionService: { authenticateStaticApiKey },
    service: {
      checkReady: vi.fn(() => Promise.resolve()),
      getActionStatus,
    },
  });
  apps.push(app);
  return { app, authenticateStaticApiKey, getActionStatus };
}

describe("PendingAction Agent route", () => {
  it("authenticates, scopes by the Agent identity, and returns the public contract", async () => {
    const { app, getActionStatus } = createApp();
    const response = await app.inject({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-request-id": "req-action-status",
      },
      method: "GET",
      url: `/v1/actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    expect(GetActionStatusResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({
      action: {
        id: ids.action,
        operation: "create_post",
        decision: "require_approval",
        state: "pending_approval",
      },
      schema_version: "1",
    });
    expect(getActionStatus).toHaveBeenCalledExactlyOnceWith(
      { ownerId: ids.owner, agentId: ids.agent },
      ids.action,
    );
  });

  it("requires actions:read before querying the action service", async () => {
    const { app, getActionStatus } = createApp({
      context: context(["research:read"]),
    });
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );
    expect(getActionStatus).not.toHaveBeenCalled();
  });

  it("preserves the indistinguishable ACTION_NOT_FOUND boundary", async () => {
    const { app } = createApp({
      getActionStatus: () =>
        Promise.reject(new PendingActionStatusError("ACTION_NOT_FOUND")),
    });
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "ACTION_NOT_FOUND",
      retryable: false,
    });
  });

  it("fails closed when a domain projection cannot satisfy the public schema", async () => {
    const invalid = {
      ...pendingAction(),
      approvalSummary: "",
      inputDigest: "private plaintext",
    };
    const { app } = createApp({ action: invalid });
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: `/v1/actions/${ids.action}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private plaintext");
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "ACTION_STATUS_UNAVAILABLE",
      retryable: true,
    });
  });

  it("rejects an invalid action identifier before querying the domain", async () => {
    const { app, getActionStatus } = createApp();
    const response = await app.inject({
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      url: "/v1/actions/bad%20id",
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(getActionStatus).not.toHaveBeenCalled();
  });
});
