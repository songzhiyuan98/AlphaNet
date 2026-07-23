import { createHmac, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiApp } from "../../apps/api/src/app.js";
import {
  BrowseContentResponseSchema,
  FindCommunitiesResponseSchema,
  GetCommunityResponseSchema,
  SearchContentResponseSchema,
} from "../../packages/contracts/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  type PostgresDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  PostgresCommunityDirectoryService,
  PostgresContentReadService,
  PostgresContentSearchService,
  PostgresFollowService,
  PostgresNotificationService,
  PostgresPendingActionStatusService,
  PostgresReactionWriteService,
  PostgresResearchWriteService,
} from "../../packages/domain/src/index.js";

const recoveryDatabaseUrl = process.env.RECOVERY_DATABASE_URL;
const mustRun = process.env.REQUIRE_RECOVERY_APPLICATION_CANARY === "true";

if (mustRun && !recoveryDatabaseUrl) {
  throw new Error(
    "RECOVERY_DATABASE_URL is required when REQUIRE_RECOVERY_APPLICATION_CANARY=true",
  );
}

const describeRecoveryCanary = recoveryDatabaseUrl ? describe : describe.skip;
const generalCommunityId = "00000000-0000-4000-8000-000000000001";

describeRecoveryCanary("restored database application canary", () => {
  const cursorSeed = Buffer.from(
    "recovery-application-canary-cursor-seed-public-test-material",
    "utf8",
  );
  const cursorKey = (label: string) =>
    createHmac("sha256", cursorSeed).update(label, "utf8").digest();
  const pendingActionKey = randomBytes(32);

  let app: Awaited<ReturnType<typeof createApiApp>>;
  let postgres: PostgresDependency;

  beforeAll(async () => {
    postgres = createPostgresDependency(recoveryDatabaseUrl ?? "");
    await postgres.check();

    const agentConnectionService = new PostgresAgentConnectionService(postgres.sql, {
      activeCredentialsPerAgent: 5,
      activeCredentialsPerOwner: 20,
      apiAudience: "urn:alphanet:api:v1",
      apiKeyCurrentPepperVersion: 1,
      apiKeyPeppers: {
        1: "recovery-canary-public-test-pepper-over-thirty-two-characters",
      },
      credentialDefaultTtlDays: 90,
      credentialIssuePerOwner24Hours: 20,
      credentialMaxTtlDays: 365,
      credentialMutationCooldownSeconds: 0,
    });
    const communityDirectoryService = new PostgresCommunityDirectoryService(
      postgres.sql,
      { cursorSigningKey: cursorKey("community") },
    );
    const contentReadService = new PostgresContentReadService(postgres.sql, {
      cursorSigningKey: cursorKey("content-read"),
    });
    const contentSearchService = new PostgresContentSearchService(postgres.sql, {
      activityDigestKey: cursorKey("content-search-activity"),
      cursorSigningKey: cursorKey("content-search"),
      embeddingProvider: null,
    });
    const followService = new PostgresFollowService(postgres.sql, {
      cursorSigningKey: cursorKey("follow"),
    });
    const notificationService = new PostgresNotificationService(postgres.sql, {
      cursorSigningKey: cursorKey("notification"),
    });
    const pendingActionStatusService = new PostgresPendingActionStatusService(
      postgres.sql,
    );
    const reactionWriteService = new PostgresReactionWriteService(postgres.sql);
    const researchWriteService = new PostgresResearchWriteService(postgres.sql, {
      pendingActionKeyRing: {
        currentVersion: 1,
        keys: { 1: pendingActionKey },
      },
    });

    app = await createApiApp({
      agentConnectionService,
      allowedOrigins: ["https://recovery-canary.alphanet.test"],
      communityDirectoryService,
      contentReadService,
      contentSearchService,
      dependencies: [postgres],
      environment: "test",
      followService,
      notificationService,
      pendingActionStatusService,
      reactionWriteService,
      researchWriteService,
      version: "recovery-application-canary",
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      return;
    }
    await closeDependencies([postgres].filter(Boolean));
  });

  it("starts the release application services against the isolated restored database", async () => {
    const readiness = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(readiness.statusCode, readiness.body).toBe(200);
    expect(readiness.json()).toMatchObject({
      status: "ok",
      version: "recovery-application-canary",
    });
  });

  it("reads restored catalog and empty social projections through public API routes", async () => {
    const directoryResponse = await app.inject({
      method: "GET",
      url: "/v1/public/communities?states=active&limit=20",
    });
    expect(directoryResponse.statusCode, directoryResponse.body).toBe(200);
    const directory = FindCommunitiesResponseSchema.parse(directoryResponse.json());
    expect(directory.items.map((community) => community.id)).toContain(
      generalCommunityId,
    );
    expect(directory.items.length).toBeGreaterThanOrEqual(7);

    const communityResponse = await app.inject({
      method: "GET",
      url: "/v1/public/communities/by-slug/general",
    });
    expect(communityResponse.statusCode, communityResponse.body).toBe(200);
    expect(GetCommunityResponseSchema.parse(communityResponse.json())).toMatchObject({
      community: {
        id: generalCommunityId,
        name: "General Market Research",
        slug: "general",
        state: "active",
      },
    });

    const browseResponse = await app.inject({
      method: "GET",
      url: `/v1/public/content?scope=community&community_id=${generalCommunityId}&sort=latest&limit=5`,
    });
    expect(browseResponse.statusCode, browseResponse.body).toBe(200);
    const browse = BrowseContentResponseSchema.parse(browseResponse.json());
    expect(browse.items).toEqual([]);
    expect(browse.page).toMatchObject({ has_more: false, limit: 5 });

    const searchResponse = await app.inject({
      method: "POST",
      payload: {
        limit: 5,
        query: "restored research",
        scope: "global",
        search_mode: "lexical",
      },
      url: "/v1/public/content/search",
    });
    expect(searchResponse.statusCode, searchResponse.body).toBe(200);
    const search = SearchContentResponseSchema.parse(searchResponse.json());
    expect(search.items).toEqual([]);
    expect(search.search_execution).toMatchObject({
      degraded: false,
      effective_mode: "lexical",
      requested_mode: "lexical",
    });
  });

  it("keeps the restored release fixture and migration head visible to the runtime role", async () => {
    const rows = await postgres.sql<
      {
        community_count: number;
        migration_version: string;
        symbol_count: number;
        topic_count: number;
      }[]
    >`
      select
        (select count(*)::integer from platform.communities) as community_count,
        (select count(*)::integer from platform.symbols) as symbol_count,
        (select count(*)::integer from platform.topics) as topic_count,
        (
          select version
          from system.schema_migrations
          order by version desc
          limit 1
        ) as migration_version
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      migration_version: "000026",
    });
    expect(rows[0]?.community_count).toBeGreaterThanOrEqual(7);
    expect(rows[0]?.symbol_count).toBeGreaterThanOrEqual(10);
    expect(rows[0]?.topic_count).toBeGreaterThanOrEqual(6);
  });
});
