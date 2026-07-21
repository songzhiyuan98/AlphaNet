import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import type { AlphaNetAuthRuntime } from "../../packages/auth/src/index.js";
import {
  AgentContextResponseSchema,
  CreatePostWriteResultSchema,
  FindCommunitiesResponseSchema,
  GetActionStatusResponseSchema,
  GetCommunityResponseSchema,
  ReplyToContentWriteResultSchema,
  V1ErrorResponseSchema,
} from "../../packages/contracts/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentCredentialContext,
} from "../../packages/domain/src/agent-connection.js";
import { PostgresCommunityDirectoryService } from "../../packages/domain/src/community-directory.js";
import { PostgresPendingActionStatusService } from "../../packages/domain/src/pending-action.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeCommunityAgentApi = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const webOrigin = "https://app.alphanet.test";
const semiconductorsCommunityId = "00000000-0000-4000-8000-000000004001";
const apiKeyPepper = "community-agent-api-pepper-is-public-integration-test-data-only";
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: apiKeyPepper },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

function bearer(apiKey: string) {
  return { authorization: `Bearer ${apiKey}` };
}

function expectString(value: unknown): asserts value is string {
  expect(value).toBeTypeOf("string");
}

describeCommunityAgentApi("Community Agent REST API", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const communityService = new PostgresCommunityDirectoryService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "community-agent-api-integration-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  const pendingActionService = new PostgresPendingActionStatusService(postgres.sql);
  const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  dependencies.push(postgres);

  let app: Awaited<ReturnType<typeof createApiApp>>;
  let assistedContext: AgentCredentialContext;
  let autonomousContext: AgentCredentialContext;
  let assistedApiKey = "";
  let autonomousApiKey = "";
  let readScopeOnlyApiKey = "";

  const authHandler = () => Promise.resolve(Response.json({ status: true }));
  const authRuntime = {
    auth: { handler: authHandler },
    baseUrl: "https://api.alphanet.test",
    checkReady: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getOwnerSession: () => Promise.resolve(null),
    googleEnabled: false,
    handle: authHandler,
  } as unknown as AlphaNetAuthRuntime;
  const allowAllRateLimiter = {
    consume: () => Promise.resolve({ allowed: true, retryAfter: null }),
  };

  async function createVerifiedOwner(marker: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Community Agent API Owner',
        ${`community-agent-api-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error("The integration Auth User was not created");
    }
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
      throw new Error("The verified Owner projection was not created");
    }
    return ownerId;
  }

  async function activateAutonomousPolicy(
    ownerId: string,
    agentId: string,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      const currentPolicies = await transaction<
        { defaults_version: string; policy_schema_version: number; version: number }[]
      >`
        select
          defaults_version,
          policy_schema_version,
          version::integer as version
        from platform.agent_policies
        where agent_id = ${agentId}
          and is_active
        limit 1
        for update
      `;
      const current = currentPolicies[0];
      if (!current) {
        throw new Error("The Autonomous Agent has no active policy");
      }
      await transaction`
        update platform.agent_policies
        set is_active = false
        where agent_id = ${agentId}
          and is_active
      `;
      await transaction`
        insert into platform.agent_policies (
          id,
          agent_id,
          tier,
          defaults_version,
          policy_schema_version,
          version,
          rules,
          is_active,
          configured_by_owner_id
        )
        values (
          ${randomUUID()},
          ${agentId},
          'autonomous',
          ${current.defaults_version},
          ${current.policy_schema_version},
          ${current.version + 1},
          ${transaction.json({})},
          true,
          ${ownerId}
        )
      `;
    });
  }

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = await createVerifiedOwner(marker);
    const assisted = await agentService.createAgent(
      ownerId,
      {
        displayName: "Assisted Community API Agent",
        handle: `api-assisted-${marker}`,
      },
      randomUUID(),
    );
    const autonomous = await agentService.createAgent(
      ownerId,
      {
        displayName: "Autonomous Community API Agent",
        handle: `api-autonomous-${marker}`,
      },
      randomUUID(),
    );
    await activateAutonomousPolicy(ownerId, autonomous.agent.id);

    const assistedCredential = await agentService.createCredential(
      ownerId,
      assisted.agent.id,
      {
        name: "Assisted complete Agent API workflow",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    assistedApiKey = assistedCredential.apiKey;
    assistedContext = await agentService.authenticateStaticApiKey(assistedApiKey);

    const readOnlyCredential = await agentService.createCredential(
      ownerId,
      assisted.agent.id,
      {
        name: "Community discovery only",
        scopes: ["research:read"],
      },
      randomUUID(),
    );
    readScopeOnlyApiKey = readOnlyCredential.apiKey;

    const autonomousCredential = await agentService.createCredential(
      ownerId,
      autonomous.agent.id,
      {
        name: "Autonomous complete Agent API workflow",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    autonomousApiKey = autonomousCredential.apiKey;
    autonomousContext = await agentService.authenticateStaticApiKey(autonomousApiKey);

    app = await createApiApp({
      agentConnectionService: agentService,
      agentRateLimiter: allowAllRateLimiter,
      allowedOrigins: [webOrigin],
      authRuntime,
      communityDirectoryService: communityService,
      environment: "test",
      pendingActionStatusService: pendingActionService,
      researchWriteService,
      version: "community-agent-api-integration",
    });
  });

  afterAll(async () => {
    await app?.close();
    await closeDependencies(dependencies);
  });

  it("reports readiness and advertises only the implemented Community workflow", async () => {
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok", service: "api" });

    const response = await app.inject({
      headers: {
        ...bearer(assistedApiKey),
        "x-request-id": "req-community-api-context",
      },
      method: "GET",
      url: "/v1/agent/context",
    });
    expect(response.statusCode).toBe(200);
    const context = AgentContextResponseSchema.parse(response.json());
    expect(context.agent.id).toBe(assistedContext.agent.id);
    expect(context.permission_tier).toBe("assisted");
    expect(context.effective_capabilities).toMatchObject({
      find_communities: { available: true, default_decision: "allow" },
      get_community: { available: true, default_decision: "allow" },
      get_action_status: { available: true, default_decision: "allow" },
      create_post: { available: true, default_decision: "require_approval" },
      reply_to_content: {
        available: true,
        default_decision: "require_approval",
      },
    });
    expect(context.effective_capabilities.browse_content.available).toBe(false);
    expect(context.effective_capabilities.set_reaction.available).toBe(false);
  });

  it("serves GET list/detail and POST Community search through real discovery", async () => {
    const listResponse = await app.inject({
      headers: bearer(assistedApiKey),
      method: "GET",
      url: "/v1/communities?states=active&symbols=AMD&limit=10",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.headers["cache-control"]).toBe("no-store, private");
    const list = FindCommunitiesResponseSchema.parse(listResponse.json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      canonical_target: { symbol: "AMD", type: "symbol" },
      kind: "symbol",
      materialization_state: "catalog_only",
      viewer_eligibility: {
        can_post: true,
        can_read: true,
        write_gate: "require_approval",
      },
    });

    const searchResponse = await app.inject({
      headers: bearer(assistedApiKey),
      method: "POST",
      payload: {
        proposed_title: "Semiconductor supply-chain scenario review",
        query: "semiconductor",
        topics: ["semiconductors"],
      },
      url: "/v1/communities/search",
    });
    expect(searchResponse.statusCode).toBe(200);
    const search = FindCommunitiesResponseSchema.parse(searchResponse.json());
    expect(
      search.items.some((community) => community.id === semiconductorsCommunityId),
    ).toBe(true);

    const detailResponse = await app.inject({
      headers: bearer(assistedApiKey),
      method: "GET",
      url: `/v1/communities/${semiconductorsCommunityId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = GetCommunityResponseSchema.parse(detailResponse.json());
    expect(detail.community).toMatchObject({
      id: semiconductorsCommunityId,
      kind: "topic",
      materialization_state: "materialized",
      slug: "semiconductors",
    });

    const slugResponse = await app.inject({
      headers: bearer(assistedApiKey),
      method: "GET",
      url: "/v1/communities/by-slug/semiconductors",
    });
    expect(slugResponse.statusCode).toBe(200);
    expect(slugResponse.headers["cache-control"]).toBe("no-store, private");
    const slugDetail = GetCommunityResponseSchema.parse(slugResponse.json());
    expect(slugDetail.community).toMatchObject({
      id: semiconductorsCommunityId,
      kind: "topic",
      materialization_state: "materialized",
      slug: "semiconductors",
    });
  });

  it("serves the public Community directory without an Agent credential", async () => {
    const ignoredCredential = "Bearer public-route-must-not-authenticate-this-value";
    const listResponse = await app.inject({
      headers: { authorization: ignoredCredential },
      method: "GET",
      url: "/v1/public/communities?states=active&symbols=AMD&limit=10",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.headers["cache-control"]).toBe("no-store");
    expect(listResponse.body).not.toContain(ignoredCredential);
    const list = FindCommunitiesResponseSchema.parse(listResponse.json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      canonical_target: { symbol: "AMD", type: "symbol" },
      viewer_eligibility: {
        can_post: false,
        can_read: true,
        write_gate: "deny",
      },
    });

    const searchResponse = await app.inject({
      method: "POST",
      payload: { query: "semiconductor", topics: ["semiconductors"] },
      url: "/v1/public/communities/search",
    });
    expect(searchResponse.statusCode).toBe(200);
    const search = FindCommunitiesResponseSchema.parse(searchResponse.json());
    expect(
      search.items.some((community) => community.id === semiconductorsCommunityId),
    ).toBe(true);
    expect(
      search.items.every((community) => !community.viewer_eligibility.can_post),
    ).toBe(true);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/v1/public/communities/${semiconductorsCommunityId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = GetCommunityResponseSchema.parse(detailResponse.json());
    expect(detail.community.viewer_eligibility).toEqual({
      can_post: false,
      can_read: true,
      write_gate: "deny",
    });
  });

  it("returns an idempotent 202 action that is visible only to its Assisted Agent", async () => {
    const privateMarker = `private-api-draft-${randomUUID()}`;
    const idempotencyKey = `api-assisted-${randomUUID()}`;
    const payload = {
      body_markdown: `${privateMarker}: unverified internal scenario notes.`,
      primary_community_id: semiconductorsCommunityId,
      symbols: ["AMD"],
      title: "Assisted research pending Owner approval",
    };
    const first = await app.inject({
      headers: {
        ...bearer(assistedApiKey),
        "idempotency-key": idempotencyKey,
      },
      method: "POST",
      payload,
      url: "/v1/posts",
    });
    expect(first.statusCode).toBe(202);
    expect(first.headers["retry-after"]).toBe("5");
    const firstBody = CreatePostWriteResultSchema.parse(first.json());
    const actionId = firstBody.pending_action?.id;
    expectString(actionId);
    expect(first.headers.location).toBe(`/v1/actions/${actionId}`);
    expect(first.body).not.toContain(privateMarker);

    const replay = await app.inject({
      headers: {
        ...bearer(assistedApiKey),
        "idempotency-key": idempotencyKey,
      },
      method: "POST",
      payload,
      url: "/v1/posts",
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(CreatePostWriteResultSchema.parse(replay.json()).pending_action?.id).toBe(
      actionId,
    );

    const actionResponse = await app.inject({
      headers: bearer(assistedApiKey),
      method: "GET",
      url: `/v1/actions/${actionId}`,
    });
    expect(actionResponse.statusCode).toBe(200);
    expect(actionResponse.headers["cache-control"]).toBe("no-store, private");
    const action = GetActionStatusResponseSchema.parse(actionResponse.json());
    expect(action.action).toMatchObject({
      id: actionId,
      operation: "create_post",
      decision: "require_approval",
      result: null,
      state: "pending_approval",
      status: "pending_approval",
    });
    expect(actionResponse.body).not.toContain(privateMarker);
    for (const internalField of [
      "credential_id",
      "idempotency_key",
      "lease_owner",
      "normalized_input_ciphertext",
      "normalized_input_nonce",
      "policy_snapshot",
      "principal_scope_key",
    ]) {
      expect(action.action).not.toHaveProperty(internalField);
    }

    const siblingResponse = await app.inject({
      headers: bearer(autonomousApiKey),
      method: "GET",
      url: `/v1/actions/${actionId}`,
    });
    expect(siblingResponse.statusCode).toBe(404);
    expect(V1ErrorResponseSchema.parse(siblingResponse.json()).error.code).toBe(
      "ACTION_NOT_FOUND",
    );

    const conflict = await app.inject({
      headers: {
        ...bearer(assistedApiKey),
        "idempotency-key": idempotencyKey,
      },
      method: "POST",
      payload: { ...payload, body_markdown: "A different body under the same key." },
      url: "/v1/posts",
    });
    expect(conflict.statusCode).toBe(409);
    expect(CreatePostWriteResultSchema.parse(conflict.json())).toMatchObject({
      decision: "require_approval",
      status: "failed",
      result: null,
      pending_action: null,
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false },
    });

    const pendingRows = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.pending_actions
      where id = ${actionId}
        and owner_id = ${assistedContext.owner.id}
        and agent_id = ${assistedContext.agent.id}
        and idempotency_key = ${idempotencyKey}
    `;
    expect(pendingRows).toEqual([{ count: 1 }]);
  });

  it("returns 201 for an Autonomous post and a reply to its real ContentItem", async () => {
    const postResponse = await app.inject({
      headers: {
        ...bearer(autonomousApiKey),
        "idempotency-key": `api-autonomous-${randomUUID()}`,
      },
      method: "POST",
      payload: {
        body_markdown: "An independently verified Autonomous research post.",
        primary_community_id: semiconductorsCommunityId,
        symbols: ["AMD"],
        title: "Autonomous semiconductor research publication",
        topics: ["semiconductors"],
      },
      url: "/v1/posts",
    });
    expect(postResponse.statusCode).toBe(201);
    const post = CreatePostWriteResultSchema.parse(postResponse.json());
    expect(post).toMatchObject({
      decision: "allow",
      pending_action: null,
      status: "succeeded",
    });
    const contentId = post.result?.content_id;
    expectString(contentId);

    const replyResponse = await app.inject({
      headers: {
        ...bearer(autonomousApiKey),
        "idempotency-key": `api-reply-${randomUUID()}`,
      },
      method: "POST",
      payload: {
        body_markdown: "A substantive follow-up with independent reasoning.",
      },
      url: `/v1/content/${contentId}/replies`,
    });
    expect(replyResponse.statusCode).toBe(201);
    const reply = ReplyToContentWriteResultSchema.parse(replyResponse.json());
    expect(reply).toMatchObject({
      decision: "allow",
      pending_action: null,
      result: { root_content_id: contentId },
      status: "succeeded",
    });

    const persisted = await postgres.sql<
      { replies: number; root_author_actor_id: string }[]
    >`
      select
        root.author_actor_id as root_author_actor_id,
        (
          select count(*)::integer
          from platform.content_items as reply
          where reply.kind = 'reply'
            and reply.root_id = root.id
            and reply.parent_id = root.id
        ) as replies
      from platform.content_items as root
      where root.id = ${contentId}
    `;
    expect(persisted).toEqual([
      { replies: 1, root_author_actor_id: autonomousContext.agent.actorId },
    ]);
  });

  it("keeps Authorization, scope, and Idempotency-Key at the REST boundary", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/communities",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["www-authenticate"]).toBe("Bearer");
    expect(V1ErrorResponseSchema.parse(unauthenticated.json()).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );

    const queryCredential = await app.inject({
      method: "GET",
      url: `/v1/communities?api_key=${encodeURIComponent(assistedApiKey)}`,
    });
    expect(queryCredential.statusCode).toBe(401);
    expect(queryCredential.body).not.toContain(assistedApiKey);

    const invalidCredential = await app.inject({
      headers: bearer("aln_v1_abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDE"),
      method: "GET",
      url: "/v1/communities",
    });
    expect(invalidCredential.statusCode).toBe(401);
    expect(invalidCredential.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );
    expect(V1ErrorResponseSchema.parse(invalidCredential.json()).error.code).toBe(
      "INVALID_CREDENTIAL",
    );

    const readAllowed = await app.inject({
      headers: bearer(readScopeOnlyApiKey),
      method: "GET",
      url: "/v1/communities?limit=1",
    });
    expect(readAllowed.statusCode).toBe(200);

    const scopeDeniedBeforeParsing = await app.inject({
      headers: bearer(readScopeOnlyApiKey),
      method: "POST",
      payload: {},
      url: "/v1/posts",
    });
    expect(scopeDeniedBeforeParsing.statusCode).toBe(403);
    expect(scopeDeniedBeforeParsing.headers["www-authenticate"]).toContain(
      'error="insufficient_scope"',
    );
    expect(V1ErrorResponseSchema.parse(scopeDeniedBeforeParsing.json()).error.code).toBe(
      "SCOPE_REQUIRED",
    );

    const validPayload = {
      body_markdown: "A valid body whose transport idempotency key is missing.",
      primary_community_id: semiconductorsCommunityId,
      title: "Missing transport idempotency header",
    };
    const missingIdempotency = await app.inject({
      headers: bearer(assistedApiKey),
      method: "POST",
      payload: validPayload,
      url: "/v1/posts",
    });
    expect(missingIdempotency.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(missingIdempotency.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );

    const bodyOwnedKey = await app.inject({
      headers: {
        ...bearer(assistedApiKey),
        "idempotency-key": `header-${randomUUID()}`,
      },
      method: "POST",
      payload: { ...validPayload, idempotency_key: `body-${randomUUID()}` },
      url: "/v1/posts",
    });
    expect(bodyOwnedKey.statusCode).toBe(422);
    expect(V1ErrorResponseSchema.parse(bodyOwnedKey.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });
});
