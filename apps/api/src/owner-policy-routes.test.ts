import type { AlphaNetAuthRuntime, OwnerSession } from "@alphanet/auth";
import {
  OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
  OwnerAgentPolicyUpdateResponseSchema,
  V1ErrorResponseSchema,
} from "@alphanet/contracts";
import {
  AgentConnectionError,
  type AgentConnectionService,
  type AgentPolicyMutationResult,
  type AgentPolicyRules,
  type AgentPolicyTier,
  type AgentPolicyView,
  type OwnerAgentView,
} from "@alphanet/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOwnerAgentPolicyRoutes } from "./owner-policy-routes.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  currentPolicy: "30000000-0000-4000-8000-000000000001",
  owner: "40000000-0000-4000-8000-000000000001",
  previousPolicy: "50000000-0000-4000-8000-000000000001",
  session: "60000000-0000-4000-8000-000000000001",
} as const;
const allowedOrigin = "https://app.alphanet.test";
const now = new Date("2026-07-21T18:00:00.000Z");
const freshCreatedAt = new Date("2026-07-21T17:55:00.000Z");
const apps: FastifyInstance[] = [];

const policyRules = {
  operations: {
    browse: "allow",
    content_read: "allow",
    content_write: "allow",
    delete_own_content: "allow",
    edit_own_content: "allow",
    follow_write: "allow",
    notification_read: "allow",
    reaction_write: "allow",
    reply_write: "allow",
    search: "allow",
  },
} as const satisfies AgentPolicyRules;

function ownerSession(createdAt = freshCreatedAt): OwnerSession {
  return {
    owner: {
      email: "owner@alphanet.test",
      emailVerified: true,
      id: ids.owner,
      name: "Research Owner",
      status: "active",
    },
    session: {
      createdAt,
      expiresAt: new Date("2026-07-28T18:00:00.000Z"),
      id: ids.session,
    },
  };
}

function policy(
  id: string,
  version: string,
  tier: AgentPolicyTier,
  rules: AgentPolicyRules = policyRules,
): AgentPolicyView {
  return {
    id,
    tier,
    defaultsVersion: "agent-permission-defaults-v1",
    schemaVersion: 1,
    version,
    effectiveFrom: now,
    rules,
  };
}

function agent(
  currentPolicy = policy(ids.currentPolicy, "4", "autonomous"),
): OwnerAgentView {
  return {
    id: ids.agent,
    actorId: ids.actor,
    ownerId: ids.owner,
    handle: "market-scout",
    displayName: "Market Scout",
    bio: "Cross-validates market research.",
    discoveryTags: ["semiconductors", "risk"],
    status: "active",
    restrictionReasonCode: null,
    credentialCount: 2,
    createdAt: now,
    updatedAt: now,
    activatedAt: now,
    archivedAt: null,
    policy: currentPolicy,
  };
}

function changedResult(): AgentPolicyMutationResult {
  return {
    changed: true,
    previousPolicy: policy(ids.previousPolicy, "3", "assisted", {
      operations: {},
    }),
    agent: agent(),
    credentialImpact: {
      retainedCredentialCount: 2,
      ceilingCounts: {
        read_only: 0,
        assisted: 2,
        autonomous: 0,
        custom: 0,
      },
    },
  };
}

function changedResultForInput(
  input: Parameters<AgentConnectionService["updateAgentPolicy"]>[2],
): AgentPolicyMutationResult {
  const rules =
    input.tier === "custom"
      ? (input.rules as AgentPolicyRules)
      : ({ operations: {} } satisfies AgentPolicyRules);
  const result = changedResult();
  result.agent = agent(policy(ids.currentPolicy, "4", input.tier, rules));
  return result;
}

function createApp(options?: {
  session?: OwnerSession | null;
  updateAgentPolicy?: AgentConnectionService["updateAgentPolicy"];
}) {
  const app = Fastify({ logger: false });
  const getOwnerSession = vi.fn<AlphaNetAuthRuntime["getOwnerSession"]>(() =>
    Promise.resolve(options && "session" in options ? options.session! : ownerSession()),
  );
  const updateAgentPolicy = vi.fn<AgentConnectionService["updateAgentPolicy"]>(
    options?.updateAgentPolicy ??
      ((_ownerId, _agentId, input) => Promise.resolve(changedResultForInput(input))),
  );
  registerOwnerAgentPolicyRoutes(app, {
    allowedOrigins: [allowedOrigin],
    authRuntime: { getOwnerSession },
    now: () => now,
    service: { updateAgentPolicy },
  });
  apps.push(app);
  return { app, getOwnerSession, updateAgentPolicy };
}

function mutationHeaders(origin = allowedOrigin) {
  return {
    "content-type": "application/json",
    cookie: "alphanet.session=opaque",
    origin,
    "sec-fetch-site": "same-origin",
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

describe("Owner Agent permission-policy route", () => {
  it("updates Autonomous only from a fresh Owner session and projects ceilings", async () => {
    const { app, updateAgentPolicy } = createApp();
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: {
        expected_version: 3,
        tier: "autonomous",
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private");
    const body = OwnerAgentPolicyUpdateResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      changed: true,
      agent: { policy: { tier: "autonomous", version: 4 } },
      credential_impact: {
        retained_credential_count: 2,
        ceiling_counts: { assisted: 2 },
        existing_credentials_keep_ceiling: true,
      },
    });
    expect(updateAgentPolicy).toHaveBeenCalledExactlyOnceWith(
      ids.owner,
      ids.agent,
      {
        authenticatedAt: freshCreatedAt,
        authenticationAssurance: "fresh_owner_session",
        autonomousAcknowledged: true,
        expectedVersion: "3",
        rules: {},
        tier: "autonomous",
      },
      expect.any(String),
    );
  });

  it("wraps flat Custom rules for the domain service", async () => {
    const { app, updateAgentPolicy } = createApp();
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: {
        expected_version: 3,
        tier: "custom",
        rules: { content_write: "deny", reaction_write: "deny" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateAgentPolicy).toHaveBeenCalledWith(
      ids.owner,
      ids.agent,
      expect.objectContaining({
        autonomousAcknowledged: false,
        rules: {
          operations: { content_write: "deny", reaction_write: "deny" },
        },
        tier: "custom",
      }),
      expect.any(String),
    );
  });

  it.each([
    {
      label: "Autonomous",
      payload: {
        expected_version: 3,
        tier: "autonomous",
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      },
    },
    {
      label: "Custom direct content write",
      payload: {
        expected_version: 3,
        tier: "custom",
        rules: { reply_write: "allow" },
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      },
    },
  ])("rejects stale-session $label expansion before the service", async ({ payload }) => {
    const { app, updateAgentPolicy } = createApp({
      session: ownerSession(new Date("2026-07-21T17:49:59.999Z")),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload,
    });

    expect(response.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_REAUTHENTICATION_REQUIRED",
    );
    expect(updateAgentPolicy).not.toHaveBeenCalled();
  });

  it("allows a stale valid session to reduce authority", async () => {
    const staleCreatedAt = new Date("2026-07-21T17:00:00.000Z");
    const { app, updateAgentPolicy } = createApp({
      session: ownerSession(staleCreatedAt),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: { expected_version: 3, tier: "read_only" },
    });

    expect(response.statusCode).toBe(200);
    expect(updateAgentPolicy).toHaveBeenCalledWith(
      ids.owner,
      ids.agent,
      expect.objectContaining({
        authenticatedAt: staleCreatedAt,
        authenticationAssurance: "owner_session",
        autonomousAcknowledged: false,
        tier: "read_only",
      }),
      expect.any(String),
    );
  });

  it.each([
    {
      label: "missing Autonomous acknowledgement",
      payload: { expected_version: 3, tier: "autonomous" },
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
    },
    {
      label: "unknown field",
      payload: { expected_version: 3, tier: "assisted", owner_id: ids.owner },
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
    },
    {
      label: "query parameter",
      payload: { expected_version: 3, tier: "assisted" },
      url: `/v1/owner/agents/${ids.agent}/permission-policy?force=true`,
    },
    {
      label: "invalid Agent id",
      payload: { expected_version: 3, tier: "assisted" },
      url: "/v1/owner/agents/not-an-id/permission-policy",
    },
  ])("rejects $label without calling the service", async ({ payload, url }) => {
    const { app, updateAgentPolicy } = createApp();
    const response = await app.inject({
      method: "PUT",
      url,
      headers: mutationHeaders(),
      payload,
    });

    expect(response.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(updateAgentPolicy).not.toHaveBeenCalled();
  });

  it("uses the shared Owner authentication and CSRF boundary", async () => {
    const unauthenticated = createApp({ session: null });
    const unauthenticatedResponse = await unauthenticated.app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: { expected_version: 3, tier: "assisted" },
    });
    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticated.updateAgentPolicy).not.toHaveBeenCalled();

    const crossOrigin = createApp();
    const crossOriginResponse = await crossOrigin.app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders("https://attacker.invalid"),
      payload: { expected_version: 3, tier: "assisted" },
    });
    expect(crossOriginResponse.statusCode).toBe(403);
    expect(V1ErrorResponseSchema.parse(crossOriginResponse.json()).error.code).toBe(
      "CSRF_VALIDATION_FAILED",
    );
    expect(crossOrigin.updateAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns safe current policy details for a version conflict", async () => {
    const { app } = createApp({
      updateAgentPolicy: () =>
        Promise.reject(
          new AgentConnectionError("AGENT_POLICY_VERSION_CONFLICT", {
            currentPolicyTier: "assisted",
            currentPolicyVersion: "7",
          }),
        ),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: { expected_version: 3, tier: "assisted" },
    });

    expect(response.statusCode).toBe(409);
    expect(V1ErrorResponseSchema.parse(response.json()).error).toMatchObject({
      code: "AGENT_POLICY_VERSION_CONFLICT",
      details: { current_tier: "assisted", current_version: 7 },
    });
  });

  it("fails closed when the domain projection violates the response contract", async () => {
    const invalidResult = changedResult();
    invalidResult.credentialImpact.retainedCredentialCount = 3;
    const { app } = createApp({
      updateAgentPolicy: () => Promise.resolve(invalidResult),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: { expected_version: 3, tier: "assisted" },
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_POLICY_UNAVAILABLE",
    );
  });

  it("fails closed when a structurally valid projection does not match the request", async () => {
    const { app } = createApp({
      updateAgentPolicy: () => Promise.resolve(changedResult()),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: { expected_version: 3, tier: "assisted" },
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_POLICY_UNAVAILABLE",
    );
  });

  it.each([
    {
      label: "another Agent",
      mutate: (result: AgentPolicyMutationResult) => {
        result.agent = { ...result.agent, id: ids.actor };
      },
    },
    {
      label: "another Owner",
      mutate: (result: AgentPolicyMutationResult) => {
        result.agent = { ...result.agent, ownerId: ids.actor };
      },
    },
    {
      label: "another previous version",
      mutate: (result: AgentPolicyMutationResult) => {
        result.previousPolicy = {
          ...result.previousPolicy,
          version: "2",
        };
      },
    },
  ])("fails closed when the projection identifies $label", async ({ mutate }) => {
    const result = changedResult();
    mutate(result);
    const { app } = createApp({
      updateAgentPolicy: () => Promise.resolve(result),
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/owner/agents/${ids.agent}/permission-policy`,
      headers: mutationHeaders(),
      payload: {
        expected_version: 3,
        tier: "autonomous",
        autonomous_acknowledgement: OWNER_AUTONOMOUS_ACKNOWLEDGEMENT,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(V1ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "OWNER_POLICY_UNAVAILABLE",
    );
  });
});
