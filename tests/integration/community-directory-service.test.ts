import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentCredentialContext,
  type AgentPolicyTier,
} from "../../packages/domain/src/agent-connection.js";
import {
  CommunityDirectoryError,
  PostgresCommunityDirectoryService,
} from "../../packages/domain/src/community-directory.js";
import {
  PostgresPendingActionStatusService,
  PendingActionStatusError,
} from "../../packages/domain/src/pending-action.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeCommunityServices = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const apiKeyPepper = "community-directory-service-pepper-is-integration-test-data-only";
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

const amdCommunityId = "00000000-0000-4000-8000-000000002001";
const amdSymbolId = "00000000-0000-4000-8000-000000001001";
const semiconductorsCommunityId = "00000000-0000-4000-8000-000000004001";
const semiconductorsTopicId = "00000000-0000-4000-8000-000000003001";

function actionActor(context: AgentCredentialContext) {
  return {
    agentId: context.agent.id,
    ownerId: context.owner.id,
  };
}

describeCommunityServices("Community directory and Agent action status", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const directoryService = new PostgresCommunityDirectoryService(postgres.sql, {
    cursorSigningKey: Buffer.from(
      "community-directory-integration-cursor-signing-key-material-v1",
      "utf8",
    ),
  });
  const actionStatusService = new PostgresPendingActionStatusService(postgres.sql);
  const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  dependencies.push(postgres);

  let primaryContext: AgentCredentialContext;
  let sameAgentReadContext: AgentCredentialContext;
  let sameAgentActionsContext: AgentCredentialContext;
  let readOnlySiblingContext: AgentCredentialContext;
  let crossOwnerContext: AgentCredentialContext;
  let primaryApiKey = "";
  let pendingActionId = "";
  let privateDraftMarker = "";

  async function createVerifiedOwner(marker: string): Promise<string> {
    const authUsers = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Community Service Integration Owner',
        ${`community-service-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const authUserId = authUsers[0]?.id;
    if (!authUserId) {
      throw new Error("The integration Auth User was not created");
    }
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
      throw new Error("The verified Owner projection was not created");
    }
    return ownerId;
  }

  async function activatePolicy(
    ownerId: string,
    agentId: string,
    tier: AgentPolicyTier,
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
        throw new Error("The sibling Agent has no active policy");
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
          ${tier},
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
    const marker = randomUUID().replaceAll("-", "").slice(0, 12);
    const ownerId = await createVerifiedOwner(marker);
    const primary = await agentService.createAgent(
      ownerId,
      {
        displayName: "Community Directory Agent",
        handle: `directory-${marker}`,
      },
      randomUUID(),
    );
    const sibling = await agentService.createAgent(
      ownerId,
      {
        displayName: "Read-only Sibling Agent",
        handle: `directory-sibling-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, sibling.agent.id, "read_only");

    const primaryCredential = await agentService.createCredential(
      ownerId,
      primary.agent.id,
      {
        name: "Community research workflow",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    primaryApiKey = primaryCredential.apiKey;
    primaryContext = await agentService.authenticateStaticApiKey(primaryApiKey);

    const sameAgentReadCredential = await agentService.createCredential(
      ownerId,
      primary.agent.id,
      {
        name: "Independent Community reader",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    sameAgentReadContext = await agentService.authenticateStaticApiKey(
      sameAgentReadCredential.apiKey,
    );

    const sameAgentActionsCredential = await agentService.createCredential(
      ownerId,
      primary.agent.id,
      {
        name: "Action polling only",
        scopes: ["actions:read"],
      },
      randomUUID(),
    );
    sameAgentActionsContext = await agentService.authenticateStaticApiKey(
      sameAgentActionsCredential.apiKey,
    );

    const siblingCredential = await agentService.createCredential(
      ownerId,
      sibling.agent.id,
      {
        name: "Read-only research workflow",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    readOnlySiblingContext = await agentService.authenticateStaticApiKey(
      siblingCredential.apiKey,
    );

    const crossOwnerId = await createVerifiedOwner(`${marker}-cross`);
    const crossOwnerAgent = await agentService.createAgent(
      crossOwnerId,
      {
        displayName: "Cross-owner Agent",
        handle: `directory-cross-${marker}`,
      },
      randomUUID(),
    );
    const crossOwnerCredential = await agentService.createCredential(
      crossOwnerId,
      crossOwnerAgent.agent.id,
      {
        name: "Cross-owner Community reader",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    crossOwnerContext = await agentService.authenticateStaticApiKey(
      crossOwnerCredential.apiKey,
    );

    privateDraftMarker = `private-draft-${randomUUID()}`;
    const pending = await researchWriteService.createPost(
      primaryContext,
      {
        additionalCommunityIds: [semiconductorsCommunityId],
        bodyMarkdown: `${privateDraftMarker}: unverified internal scenario notes.`,
        idempotencyKey: `community-service-${randomUUID()}`,
        primaryCommunityId: amdCommunityId,
        symbols: ["AMD"],
        title: "AMD scenario requiring Owner approval",
        topics: ["semiconductors"],
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    expect(pending).toMatchObject({
      decision: "require_approval",
      pendingAction: { state: "pending_approval" },
      result: null,
      status: "pending_approval",
    });
    pendingActionId = pending.pendingAction?.id ?? "";
    if (!pendingActionId) {
      throw new Error("The Assisted write did not create a PendingAction");
    }
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("reports readiness against the fully migrated research schema", async () => {
    await expect(directoryService.checkReady()).resolves.toBeUndefined();
    await expect(actionStatusService.checkReady()).resolves.toBeUndefined();
    await expect(researchWriteService.checkReady()).resolves.toBeUndefined();
  });

  it("lists, searches, and gets seeded materialized and catalog-only Communities", async () => {
    const listing = await directoryService.listCommunities(primaryContext, {
      limit: 100,
    });
    const amd = listing.items.find((item) => item.id === amdCommunityId);
    const semiconductors = listing.items.find(
      (item) => item.id === semiconductorsCommunityId,
    );

    expect(amd).toMatchObject({
      canonicalTarget: { id: amdSymbolId, symbol: "AMD", type: "symbol" },
      kind: "symbol",
      materializationState: "catalog_only",
      state: "active",
      viewerEligibility: {
        canPost: true,
        canRead: true,
        writeGate: "require_approval",
      },
    });
    expect(semiconductors).toMatchObject({
      canonicalTarget: {
        id: semiconductorsTopicId,
        slug: "semiconductors",
        type: "topic",
      },
      kind: "topic",
      materializationState: "materialized",
      state: "active",
    });

    const symbolSearch = await directoryService.searchCommunities(primaryContext, {
      symbols: ["amd"],
    });
    expect(symbolSearch.items).toHaveLength(1);
    expect(symbolSearch.items[0]).toMatchObject({
      id: amdCommunityId,
      matchReasons: ["symbol_filter_match"],
      matchedFields: ["symbols"],
    });

    const topicSearch = await directoryService.searchCommunities(primaryContext, {
      query: "semiconductor supply chains",
    });
    expect(topicSearch.items.some((item) => item.id === semiconductorsCommunityId)).toBe(
      true,
    );

    await expect(
      directoryService.getCommunity(primaryContext, { communityId: amdCommunityId }),
    ).resolves.toMatchObject({
      canonicalTarget: { id: amdSymbolId, symbol: "AMD", type: "symbol" },
      createdAt: null,
      id: amdCommunityId,
      materializationState: "catalog_only",
      updatedAt: null,
      version: 0,
    });
    await expect(
      directoryService.getCommunity(primaryContext, { slug: "semiconductors" }),
    ).resolves.toMatchObject({
      canonicalTarget: {
        id: semiconductorsTopicId,
        slug: "semiconductors",
        type: "topic",
      },
      id: semiconductorsCommunityId,
      materializationState: "materialized",
      version: 1,
    });
  });

  it("continues a stable signed cursor and rejects tampering or filter reuse", async () => {
    const first = await directoryService.listCommunities(primaryContext, { limit: 3 });
    const cursor = first.page.nextCursor;
    expect(first.page).toMatchObject({ hasMore: true, limit: 3 });
    expect(cursor).toBeTruthy();

    const second = await directoryService.listCommunities(primaryContext, {
      cursor,
      limit: 3,
    });
    expect(second.ordering).toEqual(first.ordering);
    expect(
      second.items.some((item) =>
        first.items.some((firstItem) => firstItem.id === item.id),
      ),
    ).toBe(false);

    const [encoded, signature] = cursor!.split(".");
    if (!encoded || !signature) {
      throw new Error("The directory did not return a signed cursor");
    }
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    await expect(
      directoryService.listCommunities(primaryContext, {
        cursor: `${encoded}.${tamperedSignature}`,
        limit: 3,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    await expect(
      directoryService.listCommunities(primaryContext, {
        cursor,
        limit: 3,
        states: ["active"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    for (const otherPrincipal of [
      sameAgentReadContext,
      readOnlySiblingContext,
      crossOwnerContext,
    ]) {
      await expect(
        directoryService.listCommunities(otherPrincipal, {
          cursor,
          limit: 3,
        }),
      ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    }

    const beforePolicyChange = await directoryService.listCommunities(primaryContext, {
      limit: 1,
    });
    expect(beforePolicyChange.page.nextCursor).toBeTruthy();
    await activatePolicy(
      primaryContext.owner.id,
      primaryContext.agent.id,
      primaryContext.agent.policy.tier,
    );
    primaryContext = await agentService.authenticateStaticApiKey(primaryApiKey);
    await expect(
      directoryService.listCommunities(primaryContext, {
        cursor: beforePolicyChange.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("expires pagination after catalog materialization or projected updates", async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 8);
    const symbolId = randomUUID();
    const candidateCommunityId = randomUUID();
    const ticker = `Q${marker.toUpperCase()}`;
    const communitySlug = `snapshot-${marker}`;
    await postgres.sql`
      insert into platform.symbols (
        id,
        community_candidate_id,
        ticker,
        exchange,
        name
      )
      values (
        ${symbolId},
        ${candidateCommunityId},
        ${ticker},
        'TEST',
        'Directory snapshot materialization fixture'
      )
    `;

    const beforeMaterialization = await directoryService.listCommunities(primaryContext, {
      limit: 1,
    });
    expect(beforeMaterialization.page.nextCursor).toBeTruthy();

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind
        )
        values (
          ${candidateCommunityId},
          ${communitySlug},
          ${`${ticker} Research`},
          'A materialized directory snapshot integration fixture.',
          'symbol'
        )
      `;
      await transaction`
        insert into platform.community_symbols (
          community_id,
          symbol_id,
          is_primary
        )
        values (${candidateCommunityId}, ${symbolId}, true)
      `;
    });

    await expect(
      directoryService.listCommunities(primaryContext, {
        cursor: beforeMaterialization.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });

    const afterMaterialization = await directoryService.listCommunities(primaryContext, {
      limit: 1,
    });
    expect(afterMaterialization.page.nextCursor).toBeTruthy();
    await postgres.sql`
      update platform.communities
      set name = ${`${ticker} Research Updated`},
          version = version + 1
      where id = ${candidateCommunityId}
    `;

    await expect(
      directoryService.listCommunities(primaryContext, {
        cursor: afterMaterialization.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });

    await expect(
      directoryService.getCommunity(primaryContext, {
        communityId: candidateCommunityId,
      }),
    ).resolves.toMatchObject({
      canonicalTarget: { id: symbolId, symbol: ticker, type: "symbol" },
      id: candidateCommunityId,
      materializationState: "materialized",
      name: `${ticker} Research Updated`,
      version: 2,
    });
  });

  it("enforces real credential scopes and read-only policy in directory projections", async () => {
    await expect(
      directoryService.listCommunities(sameAgentActionsContext),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CommunityDirectoryError &&
        error.code === "SCOPE_REQUIRED" &&
        error.policyReason === "SCOPE_REQUIRED",
    );

    const readOnlyProjection = await directoryService.getCommunity(
      readOnlySiblingContext,
      { slug: "semiconductors" },
    );
    expect(readOnlySiblingContext.agent.policy.tier).toBe("read_only");
    expect(readOnlySiblingContext.credential.policyCeiling).toBe("read_only");
    expect(readOnlyProjection.viewerEligibility).toEqual({
      canPost: false,
      canRead: true,
      writeGate: "deny",
    });
  });

  it("exposes a secret-free PendingAction view only to the owning Agent identity", async () => {
    const creatorView = await actionStatusService.getActionStatus(
      actionActor(primaryContext),
      pendingActionId,
    );
    expect(creatorView).toMatchObject({
      approvalMethod: null,
      approvalOutcome: null,
      decision: "require_approval",
      error: null,
      id: pendingActionId,
      operation: "create_post",
      result: null,
      state: "pending_approval",
      status: "pending_approval",
    });
    expect(creatorView.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.keys(creatorView).sort()).toEqual(
      [
        "approvalMethod",
        "approvalOutcome",
        "approvalSummary",
        "completedAt",
        "decidedAt",
        "decidedByOwnerId",
        "decision",
        "decisionId",
        "error",
        "executingAt",
        "expiresAt",
        "id",
        "inputDigest",
        "operation",
        "policyVersion",
        "requestedAt",
        "result",
        "state",
        "status",
        "terminalAt",
      ].sort(),
    );

    const serializedView = JSON.stringify(creatorView);
    expect(serializedView).not.toContain(privateDraftMarker);
    expect(serializedView).not.toContain(primaryApiKey);
    expect(serializedView).not.toContain(primaryContext.credential.id);
    for (const internalField of [
      "auditId",
      "credentialId",
      "idempotencyKey",
      "leaseOwner",
      "normalizedInputCiphertext",
      "normalizedInputNonce",
      "ownerId",
      "policySnapshot",
      "principalScopeKey",
    ]) {
      expect(creatorView).not.toHaveProperty(internalField);
    }

    const sameAgentView = await actionStatusService.getActionStatus(
      actionActor(sameAgentActionsContext),
      pendingActionId,
    );
    expect(sameAgentView).toEqual(creatorView);

    for (const hiddenContext of [readOnlySiblingContext, crossOwnerContext]) {
      await expect(
        actionStatusService.getActionStatus(actionActor(hiddenContext), pendingActionId),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof PendingActionStatusError &&
          error.code === "ACTION_NOT_FOUND" &&
          error.statusCode === 404,
      );
    }
  });
});
