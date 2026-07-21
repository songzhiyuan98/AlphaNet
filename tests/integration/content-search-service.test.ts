import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
  type OutboxEvent,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentCredentialContext,
  type AgentPolicyTier,
} from "../../packages/domain/src/agent-connection.js";
import {
  TITAN_TEXT_EMBED_V2_INDEX_MODEL,
  type TextEmbeddingProvider,
} from "../../packages/domain/src/bedrock-embedding.js";
import { PostgresContentSearchService } from "../../packages/domain/src/content-search.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";
import {
  SearchIndexer,
  type SearchIndexJobLease,
} from "../../packages/domain/src/search-indexer.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeSearch = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "content-search-integration-pepper-is-test-data-only-v1",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;
const fixtureAgentContentRateLimits = {
  establishedPostsPerHour: 10_000,
  establishedRepliesPerHour: 10_000,
  newAgentPostsPerHour: 10_000,
  newAgentRepliesPerHour: 10_000,
} as const;
const postingRules = {
  allowed_content: ["investment-research", "discussion", "question"],
  max_posts_per_hour: 1_000,
  replies_open: true,
  requires_sources: false,
} as const;
const normalizedVector = Array.from({ length: 512 }, () => 1 / Math.sqrt(512));
const firstAxisVector = Array.from({ length: 512 }, (_value, index) =>
  index === 0 ? 1 : 0,
);
const secondAxisVector = Array.from({ length: 512 }, (_value, index) =>
  index === 1 ? 1 : 0,
);

interface CreatedContent {
  contentId: string;
  revisionId: string;
}

interface CapturedPostgresQuery {
  parameters: unknown[];
  text: string;
}

function searchDocumentResidualPredicates(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(searchDocumentResidualPredicates);
  }
  if (typeof value !== "object" || value === null) return [];

  const residuals: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "Filter" || key === "Join Filter") &&
      typeof child === "string" &&
      child.includes("search_document")
    ) {
      residuals.push(child);
    }
    residuals.push(...searchDocumentResidualPredicates(child));
  }
  return residuals;
}

function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

function deterministicProvider(calls: string[] = []): TextEmbeddingProvider {
  return {
    dimensions: 512,
    indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
    modelId: "amazon.titan-embed-text-v2:0",
    embed(text) {
      calls.push(text);
      return Promise.resolve(normalizedVector);
    },
  };
}

describeSearch("Postgres Content Search v1", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const searchEmbeddingCalls: string[] = [];
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const writeService = new PostgresResearchWriteService(postgres.sql, {
    agentContentRateLimits: fixtureAgentContentRateLimits,
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
  });
  const searchService = new PostgresContentSearchService(postgres.sql, {
    activityDigestKey: Buffer.from(
      "content-search-integration-activity-digest-key-v1",
      "utf8",
    ),
    cursorSigningKey: Buffer.from(
      "content-search-integration-cursor-signing-key-v1",
      "utf8",
    ),
    embeddingProvider: deterministicProvider(searchEmbeddingCalls),
  });
  dependencies.push(postgres);

  let marker = "";
  let mainToken = "";
  let currentToken = "";
  let obsoleteToken = "";
  let visibilityToken = "";
  let placementVisibilityToken = "";
  let classificationToken = "";
  let partialToken = "";
  let boundedSemanticToken = "";
  let cursorToken = "";
  let indexToken = "";
  let communityAId = "";
  let communityBId = "";
  let cursorCommunityId = "";
  let partialCommunityId = "";
  let semanticCommunityId = "";
  let deletedPlacementCommunityId = "";
  let suspendedPlacementCommunityId = "";
  let symbolA = "";
  let symbolB = "";
  let topicA = "";
  let topicB = "";
  let symbolAId = "";
  let topicAId = "";
  let authorContext: AgentCredentialContext;
  let searcherContext: AgentCredentialContext;
  let discoveryContext: AgentCredentialContext;
  let limiterContext: AgentCredentialContext;
  let rootA: CreatedContent;
  let replyA: CreatedContent;
  let rootB: CreatedContent;
  let currentRevisionContent: CreatedContent;
  let visibleContent: CreatedContent;
  let hiddenContent: CreatedContent;
  let deletedContent: CreatedContent;
  let placementVisibilityContent: CreatedContent;
  let classificationContent: CreatedContent;
  let classificationUpdatedAt: Date;
  let partialIndexedContent: CreatedContent;
  let partialUnindexedContent: CreatedContent;
  let cursorContents: CreatedContent[] = [];
  let indexContent: CreatedContent;

  async function createVerifiedOwner(testMarker: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Content Search Integration Owner',
        ${`content-search-${testMarker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const userId = requireId(users[0]?.id, "Content Search Auth User");
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${userId}::uuid
    `;
    return requireId(owners[0]?.id, "Content Search Owner projection");
  }

  async function activatePolicy(
    ownerId: string,
    agentId: string,
    tier: AgentPolicyTier,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      const policies = await transaction<
        { defaults_version: string; policy_schema_version: number; version: number }[]
      >`
        select
          defaults_version,
          policy_schema_version,
          version::integer as version
        from platform.agent_policies
        where agent_id = ${agentId}::uuid
          and is_active
        limit 1
        for update
      `;
      const current = policies[0];
      if (current === undefined) {
        throw new Error("Content Search Agent has no active policy");
      }
      await transaction`
        update platform.agent_policies
        set is_active = false
        where agent_id = ${agentId}::uuid
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
          ${randomUUID()}::uuid,
          ${agentId}::uuid,
          ${tier},
          ${current.defaults_version},
          ${current.policy_schema_version},
          ${current.version + 1},
          ${transaction.json({})},
          true,
          ${ownerId}::uuid
        )
      `;
    });
  }

  async function createContext(
    ownerId: string,
    label: string,
    scopes: ("content:write" | "research:read")[],
  ): Promise<AgentCredentialContext> {
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: `Search ${label} Agent`,
        handle: `search-${label}-${marker}`,
      },
      randomUUID(),
    );
    await activatePolicy(ownerId, created.agent.id, "autonomous");
    const credential = await agentService.createCredential(
      ownerId,
      created.agent.id,
      {
        name: `Search ${label} integration credential`,
        scopes,
      },
      randomUUID(),
    );
    return agentService.authenticateStaticApiKey(credential.apiKey);
  }

  async function createPost(options: {
    additionalCommunityIds?: string[];
    body: string;
    communityId?: string;
    sourceLinks?: { description?: string; title?: string; url: string }[];
    symbol?: string;
    title: string;
    topic?: string;
  }): Promise<CreatedContent> {
    const outcome = await writeService.createPost(
      authorContext,
      {
        additionalCommunityIds: options.additionalCommunityIds ?? [],
        bodyMarkdown: options.body,
        idempotencyKey: `search-post-${randomUUID()}`,
        primaryCommunityId: options.communityId ?? communityAId,
        sourceLinks: options.sourceLinks ?? [],
        ...(options.symbol === undefined ? {} : { symbols: [options.symbol] }),
        title: options.title,
        ...(options.topic === undefined ? {} : { topics: [options.topic] }),
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    if (outcome.status !== "succeeded" || outcome.result === null) {
      throw new Error(`Content Search fixture post failed: ${outcome.status}`);
    }
    return {
      contentId: outcome.result.contentId,
      revisionId: requireId(
        outcome.result.revisionId ?? undefined,
        "Content Search post Revision",
      ),
    };
  }

  async function createReply(
    parentContentId: string,
    body: string,
  ): Promise<CreatedContent> {
    const outcome = await writeService.replyToContent(
      authorContext,
      {
        bodyMarkdown: body,
        idempotencyKey: `search-reply-${randomUUID()}`,
        parentContentId,
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    if (outcome.status !== "succeeded" || outcome.result === null) {
      throw new Error(`Content Search fixture reply failed: ${outcome.status}`);
    }
    return {
      contentId: outcome.result.contentId,
      revisionId: requireId(
        outcome.result.revisionId ?? undefined,
        "Content Search reply Revision",
      ),
    };
  }

  async function insertEmbeddingChunk(
    revisionId: string,
    embedding: readonly number[] = normalizedVector,
  ): Promise<void> {
    await postgres.sql`
      insert into platform.content_embedding_chunks (
        revision_id,
        embedding_model,
        chunk_index,
        source_start_offset,
        source_end_offset,
        source_text_hash,
        token_count,
        embedding
      )
      values (
        ${revisionId}::uuid,
        ${TITAN_TEXT_EMBED_V2_INDEX_MODEL},
        0,
        0,
        1,
        ${randomBytes(32)},
        1,
        ${JSON.stringify(embedding)}::vector(512)
      )
    `;
  }

  beforeAll(async () => {
    marker = randomUUID().replaceAll("-", "").slice(0, 10);
    mainToken = `quasar${marker}`;
    obsoleteToken = `obsolete${marker}`;
    currentToken = `current${marker}`;
    visibilityToken = `visible${marker}`;
    placementVisibilityToken = `placement${marker}`;
    classificationToken = `classification${marker}`;
    partialToken = `partial${marker}`;
    boundedSemanticToken = `bounded${marker}`;
    cursorToken = `cursor${marker}`;
    indexToken = `index${marker}`;
    communityAId = randomUUID();
    communityBId = randomUUID();
    cursorCommunityId = randomUUID();
    partialCommunityId = randomUUID();
    semanticCommunityId = randomUUID();
    deletedPlacementCommunityId = randomUUID();
    suspendedPlacementCommunityId = randomUUID();
    topicAId = randomUUID();
    const topicBId = randomUUID();
    symbolAId = randomUUID();
    const symbolBId = randomUUID();
    symbolA = `A${marker.slice(0, 8).toUpperCase()}`;
    symbolB = `B${marker.slice(0, 8).toUpperCase()}`;
    topicA = `search-a-${marker}`;
    topicB = `search-b-${marker}`;

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (${topicAId}::uuid, ${topicA}, 'Search integration topic A', 'Search filters A'),
          (${topicBId}::uuid, ${topicB}, 'Search integration topic B', 'Search filters B')
      `;
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind,
          posting_rules,
          settings
        )
        values
          (
            ${communityAId}::uuid,
            ${`search-community-a-${marker}`},
            'Search integration Community A',
            'Agent investment research social Search fixture A.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-a" })}
          ),
          (
            ${communityBId}::uuid,
            ${`search-community-b-${marker}`},
            'Search integration Community B',
            'Agent investment research social Search fixture B.',
            'topic',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-b" })}
          ),
          (
            ${cursorCommunityId}::uuid,
            ${`search-cursor-${marker}`},
            'Search cursor snapshot fixture',
            'An isolated Community for Search snapshot stability.',
            'general',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-cursor" })}
          ),
          (
            ${partialCommunityId}::uuid,
            ${`search-partial-${marker}`},
            'Search partial index fixture',
            'An isolated Community for partial hybrid coverage.',
            'general',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-partial" })}
          ),
          (
            ${semanticCommunityId}::uuid,
            ${`search-semantic-${marker}`},
            'Search semantic candidate fixture',
            'An isolated Community for bounded vector candidates.',
            'general',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-semantic" })}
          ),
          (
            ${suspendedPlacementCommunityId}::uuid,
            ${`search-suspended-${marker}`},
            'Search suspended placement fixture',
            'A placement visibility boundary for public Search.',
            'general',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-suspended" })}
          ),
          (
            ${deletedPlacementCommunityId}::uuid,
            ${`search-deleted-${marker}`},
            'Search deleted placement fixture',
            'A deleted placement boundary for every Search principal.',
            'general',
            ${transaction.json(postingRules)},
            ${transaction.json({ fixture: marker, slice: "search-deleted" })}
          )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values
          (${communityAId}::uuid, ${topicAId}::uuid, true),
          (${communityBId}::uuid, ${topicBId}::uuid, true)
      `;
      await transaction`
        insert into platform.symbols (
          id,
          community_candidate_id,
          ticker,
          exchange,
          name
        )
        values
          (
            ${symbolAId}::uuid,
            ${randomUUID()}::uuid,
            ${symbolA},
            'TEST',
            'Search integration symbol A'
          ),
          (
            ${symbolBId}::uuid,
            ${randomUUID()}::uuid,
            ${symbolB},
            'TEST',
            'Search integration symbol B'
          )
      `;
    });

    const ownerId = await createVerifiedOwner(marker);
    authorContext = await createContext(ownerId, "author", [
      "research:read",
      "content:write",
    ]);
    searcherContext = await createContext(ownerId, "reader", ["research:read"]);
    discoveryContext = await createContext(ownerId, "discovery", ["research:read"]);
    const limiterOwnerId = await createVerifiedOwner(`${marker}-limiter`);
    limiterContext = await createContext(limiterOwnerId, "limiter", ["research:read"]);

    rootA = await createPost({
      body: `${mainToken} tracks primary evidence and supply-chain risk in Community A.`,
      communityId: communityAId,
      sourceLinks: Array.from({ length: 4 }, (_value, index) => ({
        description: `Bounded Search source ${index + 1}`,
        title: `Source ${index + 1}`,
        url: `https://evidence.example.test/${marker}/source-${index + 1}`,
      })),
      symbol: symbolA,
      title: "Searchable market thesis in Community A",
      topic: topicA,
    });
    replyA = await createReply(
      rootA.contentId,
      `${mainToken} counterargument adds a directly addressable reply.`,
    );
    rootB = await createPost({
      body: `${mainToken} independent demand evidence belongs to Community B.`,
      communityId: communityBId,
      symbol: symbolB,
      title: "Searchable market thesis in Community B",
      topic: topicB,
    });

    currentRevisionContent = await createPost({
      body: `${obsoleteToken} was present only in the first immutable Revision.`,
      title: "Current Revision selection fixture",
    });
    const updated = await writeService.updateContent(
      authorContext,
      {
        contentId: currentRevisionContent.contentId,
        editSummary: "Replace the obsolete hypothesis after independent verification.",
        expectedVersion: 1,
        idempotencyKey: `search-update-${randomUUID()}`,
        patch: {
          bodyMarkdown: `${currentToken} is the only searchable current hypothesis.`,
        },
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    if (updated.status !== "succeeded" || updated.result === null) {
      throw new Error(
        `Content Search current Revision fixture failed: ${updated.status}`,
      );
    }
    currentRevisionContent = {
      contentId: updated.result.contentId,
      revisionId: requireId(updated.result.revisionId ?? undefined, "Updated Revision"),
    };

    classificationContent = await createPost({
      body: `${classificationToken} keeps its immutable Revision during retagging.`,
      title: "Classification-only Search projection fixture",
    });
    const classificationUpdate = await writeService.updateContent(
      authorContext,
      {
        contentId: classificationContent.contentId,
        expectedVersion: 1,
        idempotencyKey: `search-classification-${randomUUID()}`,
        patch: { symbols: [symbolA] },
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    if (
      classificationUpdate.status !== "succeeded" ||
      classificationUpdate.result === null ||
      classificationUpdate.result.revisionId !== null
    ) {
      throw new Error("Content Search classification-only fixture failed");
    }
    const classificationRows = await postgres.sql<
      { current_revision_id: string; updated_at: Date; version: number }[]
    >`
      select
        current_revision_id::text as current_revision_id,
        updated_at,
        version::integer as version
      from platform.content_items
      where id = ${classificationContent.contentId}::uuid
    `;
    const classificationRow = classificationRows[0];
    if (
      classificationRow === undefined ||
      classificationRow.current_revision_id !== classificationContent.revisionId ||
      classificationRow.version !== 2 ||
      !(classificationRow.updated_at instanceof Date)
    ) {
      throw new Error("Content Search classification-only state is inconsistent");
    }
    classificationUpdatedAt = classificationRow.updated_at;

    visibleContent = await createPost({
      body: `${visibilityToken} must remain visible.`,
      title: "Visible Search lifecycle fixture",
    });
    hiddenContent = await createPost({
      body: `${visibilityToken} must be removed by distribution visibility.`,
      title: "Hidden Search lifecycle fixture",
    });
    deletedContent = await createPost({
      body: `${visibilityToken} must be removed by lifecycle visibility.`,
      title: "Deleted Search lifecycle fixture",
    });
    placementVisibilityContent = await createPost({
      additionalCommunityIds: [
        suspendedPlacementCommunityId,
        deletedPlacementCommunityId,
      ],
      body: `${placementVisibilityToken} is cross-posted from an active Community.`,
      title: "Cross-Community Search visibility fixture",
    });
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${hiddenContent.contentId}::uuid
    `;
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${deletedContent.contentId}::uuid
    `;
    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = 'suspended'
      where id = ${suspendedPlacementCommunityId}::uuid
    `;
    await postgres.sql`
      update platform.communities
      set version = version + 1,
          status = 'archived',
          deleted_at = clock_timestamp()
      where id = ${deletedPlacementCommunityId}::uuid
    `;

    cursorContents = [];
    cursorContents.push(
      await createPost({
        body: `${cursorToken} first stable cursor member.`,
        communityId: cursorCommunityId,
        title: "Stable Search cursor fixture one",
      }),
    );
    cursorContents.push(
      await createPost({
        body: `${cursorToken} second stable cursor member.`,
        communityId: cursorCommunityId,
        title: "Stable Search cursor fixture two",
      }),
    );
    cursorContents.push(
      await createPost({
        body: `${cursorToken} third stable cursor member.`,
        communityId: cursorCommunityId,
        title: "Stable Search cursor fixture three",
      }),
    );
    await insertEmbeddingChunk(cursorContents[0]!.revisionId);
    await insertEmbeddingChunk(cursorContents[1]!.revisionId);

    partialIndexedContent = await createPost({
      body: `${partialToken} has lexical and semantic coverage.`,
      communityId: partialCommunityId,
      title: "Indexed hybrid coverage fixture",
    });
    partialUnindexedContent = await createPost({
      body: `${partialToken} intentionally has lexical-only coverage.`,
      communityId: partialCommunityId,
      title: "Unindexed hybrid coverage fixture",
    });
    await insertEmbeddingChunk(partialIndexedContent.revisionId);
    indexContent = await createPost({
      body: `${indexToken} is embedded through a deterministic provider.`,
      title: "Durable Search indexing fixture",
    });

    await postgres.sql`
      insert into platform.follows (
        follower_actor_id,
        target_type,
        target_actor_id,
        target_symbol_id,
        target_topic_id,
        target_content_id,
        notification_level
      )
      values (
        ${searcherContext.agent.actorId}::uuid,
        'actor',
        ${authorContext.agent.actorId}::uuid,
        null,
        null,
        null,
        'new_posts'
      )
    `;
    await postgres.sql`
      insert into platform.follows (
        follower_actor_id,
        target_type,
        target_actor_id,
        target_symbol_id,
        target_topic_id,
        target_content_id,
        notification_level
      )
      values
        (
          ${discoveryContext.agent.actorId}::uuid,
          'symbol',
          null,
          ${symbolAId}::uuid,
          null,
          null,
          'feed_only'
        ),
        (
          ${discoveryContext.agent.actorId}::uuid,
          'topic',
          null,
          null,
          ${topicAId}::uuid,
          null,
          'feed_only'
        )
    `;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("exposes the fresh 000013 lexical, vector, queue, epoch, and privacy schema", async () => {
    await expect(searchService.checkReady()).resolves.toBeUndefined();
    const rows = await postgres.sql<
      {
        activity_column_count: number;
        has_activity_table: boolean;
        has_claim_function: boolean;
        has_embedding_table: boolean;
        has_lexical_index: boolean;
        has_search_epoch: boolean;
        search_document_generated: boolean;
        vector_dimensions: number;
      }[]
    >`
      select
        to_regclass('platform.agent_search_activity_events') is not null
          as has_activity_table,
        to_regclass('platform.content_embedding_chunks') is not null
          as has_embedding_table,
        to_regclass('platform.content_revisions_search_document_idx') is not null
          as has_lexical_index,
        to_regprocedure(
          'system.claim_content_embedding_jobs(text,bytea,integer,integer)'
        ) is not null as has_claim_function,
        exists (
          select 1
          from system.content_read_visibility_epochs
          where epoch_name = 'search_index'
        ) as has_search_epoch,
        (
          select attribute.attgenerated = 's'
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = 'platform.content_revisions'::regclass
            and attribute.attname = 'search_document'
            and not attribute.attisdropped
        ) as search_document_generated,
        (
          select attribute.atttypmod
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = 'platform.content_embedding_chunks'::regclass
            and attribute.attname = 'embedding'
            and not attribute.attisdropped
        ) as vector_dimensions,
        (
          select count(*)::integer
          from information_schema.columns
          where table_schema = 'platform'
            and table_name = 'agent_search_activity_events'
        ) as activity_column_count
    `;
    expect(rows[0]).toEqual({
      activity_column_count: 19,
      has_activity_table: true,
      has_claim_function: true,
      has_embedding_table: true,
      has_lexical_index: true,
      has_search_epoch: true,
      search_document_generated: true,
      vector_dimensions: 512,
    });

    const capturedCandidates: CapturedPostgresQuery[] = [];
    const previousDebug = postgres.sql.options.debug;
    postgres.sql.options.debug = (_connection, query, parameters) => {
      if (query.includes("with query_input as materialized")) {
        capturedCandidates.push({ parameters: [...parameters], text: query });
      }
    };
    try {
      await searchService.searchContent(null, {
        limit: 1,
        query: mainToken,
        scope: "global",
        searchMode: "lexical",
      });
    } finally {
      postgres.sql.options.debug = previousDebug;
    }

    const candidateQuery = capturedCandidates[0];
    if (candidateQuery === undefined) {
      throw new Error("Content Search did not execute its candidate query");
    }
    const lexicalPlan = await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      return transaction.unsafe<{ "QUERY PLAN": unknown }[]>(
        `explain (format json, costs off) ${candidateQuery.text}`,
        candidateQuery.parameters as never[],
      );
    });
    const plan = lexicalPlan[0]?.["QUERY PLAN"];
    expect(JSON.stringify(plan)).toContain("content_revisions_search_document_idx");
    expect(searchDocumentResidualPredicates(plan)).toEqual([]);
  });

  it("searches only the current Revision and returns independently addressable replies", async () => {
    const obsolete = await searchService.searchContent(null, {
      query: obsoleteToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(obsolete.items).toEqual([]);

    const current = await searchService.searchContent(null, {
      query: currentToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(current.items).toHaveLength(1);
    expect(current.items[0]).toMatchObject({
      contentId: currentRevisionContent.contentId,
      currentRevisionId: currentRevisionContent.revisionId,
      kind: "post",
      matchedFields: ["body"],
      snippetSourceRevisionId: currentRevisionContent.revisionId,
    });

    const socialResults = await searchService.searchContent(null, {
      contentTypes: ["reply"],
      query: mainToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(socialResults.items).toHaveLength(1);
    expect(socialResults.items[0]).toMatchObject({
      contentId: replyA.contentId,
      contextTitle: "Searchable market thesis in Community A",
      kind: "reply",
      parentContentId: rootA.contentId,
      rootContentId: rootA.contentId,
    });
  });

  it("projects classification-only version and update time without inventing a Revision", async () => {
    const page = await searchService.searchContent(null, {
      query: classificationToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      contentId: classificationContent.contentId,
      contentVersion: 2,
      currentRevisionId: classificationContent.revisionId,
      snippetSourceRevisionId: classificationContent.revisionId,
      symbols: [symbolA],
      updatedAt: classificationUpdatedAt,
    });
  });

  it("applies Community, symbol, topic, author, following, and array filters", async () => {
    const community = await searchService.searchContent(null, {
      communityId: communityAId,
      query: mainToken,
      scope: "community",
      searchMode: "lexical",
    });
    expect(new Set(community.items.map((item) => item.contentId))).toEqual(
      new Set([rootA.contentId, replyA.contentId]),
    );
    expect(
      community.items.find((item) => item.contentId === rootA.contentId)?.sourcePreview,
    ).toEqual(
      Array.from({ length: 3 }, (_value, index) => ({
        description: `Bounded Search source ${index + 1}`,
        title: `Source ${index + 1}`,
        url: `https://evidence.example.test/${marker}/source-${index + 1}`,
      })),
    );

    const symbol = await searchService.searchContent(null, {
      query: mainToken,
      scope: "symbol",
      searchMode: "lexical",
      symbol: symbolA,
    });
    expect(symbol.items.map((item) => item.contentId)).toEqual([rootA.contentId]);

    const topic = await searchService.searchContent(null, {
      query: mainToken,
      scope: "topic",
      searchMode: "lexical",
      topic: topicB,
    });
    expect(topic.items.map((item) => item.contentId)).toEqual([rootB.contentId]);

    const author = await searchService.searchContent(null, {
      authorActorId: authorContext.agent.actorId,
      communityIds: [communityBId],
      query: mainToken,
      scope: "author",
      searchMode: "lexical",
      symbols: [symbolB],
      topics: [topicB],
    });
    expect(author.items.map((item) => item.contentId)).toEqual([rootB.contentId]);

    const following = await searchService.searchContent(
      searcherContext,
      {
        query: mainToken,
        scope: "following",
        searchMode: "lexical",
      },
      { channel: "sdk", requestId: `req-${randomUUID()}` },
    );
    expect(new Set(following.items.map((item) => item.contentId))).toEqual(
      new Set([rootA.contentId, replyA.contentId, rootB.contentId]),
    );
  });

  it("inherits followed root symbols and topics into reply Search discovery", async () => {
    const following = await searchService.searchContent(
      discoveryContext,
      {
        query: mainToken,
        scope: "following",
        searchMode: "lexical",
      },
      { channel: "sdk", requestId: `req-${randomUUID()}` },
    );
    expect(new Set(following.items.map((item) => item.contentId))).toEqual(
      new Set([rootA.contentId, replyA.contentId]),
    );
    expect(
      following.items.find((item) => item.contentId === replyA.contentId),
    ).toMatchObject({
      kind: "reply",
      rootContentId: rootA.contentId,
    });
  });

  it("never returns hidden or deleted Content", async () => {
    const publicPage = await searchService.searchContent(null, {
      query: visibilityToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(publicPage.items.map((item) => item.contentId)).toEqual([
      visibleContent.contentId,
    ]);

    const agentPage = await searchService.searchContent(
      searcherContext,
      {
        query: visibilityToken,
        scope: "global",
        searchMode: "lexical",
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    expect(agentPage.items.map((item) => item.contentId)).toEqual([
      visibleContent.contentId,
    ]);
    expect(agentPage.items.map((item) => item.contentId)).not.toContain(
      hiddenContent.contentId,
    );
    expect(agentPage.items.map((item) => item.contentId)).not.toContain(
      deletedContent.contentId,
    );
  });

  it("enforces visibility on the exact Community scope and filter that matched", async () => {
    const global = await searchService.searchContent(null, {
      query: placementVisibilityToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(global.items.map((item) => item.contentId)).toEqual([
      placementVisibilityContent.contentId,
    ]);

    const publicSuspendedScope = await searchService.searchContent(null, {
      communityId: suspendedPlacementCommunityId,
      query: placementVisibilityToken,
      scope: "community",
      searchMode: "lexical",
    });
    expect(publicSuspendedScope.items).toEqual([]);
    const publicSuspendedFilter = await searchService.searchContent(null, {
      communityIds: [suspendedPlacementCommunityId],
      query: placementVisibilityToken,
      scope: "global",
      searchMode: "lexical",
    });
    expect(publicSuspendedFilter.items).toEqual([]);

    const agentSuspendedScope = await searchService.searchContent(
      searcherContext,
      {
        communityId: suspendedPlacementCommunityId,
        query: placementVisibilityToken,
        scope: "community",
        searchMode: "lexical",
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    expect(agentSuspendedScope.items.map((item) => item.contentId)).toEqual([
      placementVisibilityContent.contentId,
    ]);

    const agentDeletedScope = await searchService.searchContent(
      searcherContext,
      {
        communityId: deletedPlacementCommunityId,
        query: placementVisibilityToken,
        scope: "community",
        searchMode: "lexical",
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    expect(agentDeletedScope.items).toEqual([]);
  });

  it("discloses partial hybrid index coverage without dropping lexical results", async () => {
    const hybrid = await searchService.searchContent(null, {
      communityId: partialCommunityId,
      query: partialToken,
      scope: "community",
      searchMode: "hybrid",
    });
    expect(new Set(hybrid.items.map((item) => item.contentId))).toEqual(
      new Set([partialIndexedContent.contentId, partialUnindexedContent.contentId]),
    );
    expect(hybrid).toMatchObject({
      searchExecution: {
        degraded: false,
        degradationReason: null,
        effectiveMode: "hybrid",
        requestedMode: "hybrid",
      },
      semanticIndexCoverage: {
        complete: false,
        unindexedCandidateCount: 1,
      },
    });
    expect(
      hybrid.items.find((item) => item.contentId === partialIndexedContent.contentId)
        ?.matchedFields,
    ).toEqual(expect.arrayContaining(["body", "semantic"]));
    expect(
      hybrid.items.find((item) => item.contentId === partialUnindexedContent.contentId)
        ?.matchedFields,
    ).toEqual(["body"]);
  });

  it("stores the maximum cursor TTL within the database retention boundary", async () => {
    const maximumTtlService = new PostgresContentSearchService(postgres.sql, {
      activityDigestKey: Buffer.from(
        "maximum-ttl-integration-activity-digest-key-v1",
        "utf8",
      ),
      cursorSigningKey: Buffer.from(
        "maximum-ttl-integration-cursor-signing-key-v1",
        "utf8",
      ),
      cursorTtlSeconds: 3_600,
    });
    const first = await maximumTtlService.searchContent(null, {
      communityId: cursorCommunityId,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "lexical",
      sort: "latest",
    });

    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.ranking.expiresAt.valueOf() - first.ranking.asOf.valueOf()).toBe(
      3_600_000 - 1,
    );
    const stored = await postgres.sql<{ created_at: Date; expires_at: Date }[]>`
      select created_at, expires_at
      from system.content_search_candidate_snapshots
      where snapshot_id = ${first.ranking.snapshotId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.expires_at).toEqual(first.ranking.expiresAt);
    expect(
      stored[0]!.expires_at.valueOf() - stored[0]!.created_at.valueOf(),
    ).toBeLessThanOrEqual(3_600_000);

    await expect(
      maximumTtlService.searchContent(null, {
        communityId: cursorCommunityId,
        cursor: first.page.nextCursor,
        limit: 1,
        query: cursorToken,
        scope: "community",
        searchMode: "lexical",
        sort: "latest",
      }),
    ).resolves.toMatchObject({ ranking: { snapshotId: first.ranking.snapshotId } });
  });

  it("keeps a signed snapshot stable and invalidates it after visibility changes", async () => {
    const first = await searchService.searchContent(null, {
      communityId: cursorCommunityId,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "hybrid",
      sort: "latest",
    });
    expect(first.items).toHaveLength(1);
    expect(first.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.page.nextCursor!.length).toBeLessThanOrEqual(4_096);
    expect(first.semanticIndexCoverage).toEqual({
      complete: false,
      unindexedCandidateCount: 1,
    });
    const storedSnapshots = await postgres.sql<
      { candidate_count: number; candidates_text: string }[]
    >`
      select
        jsonb_array_length(candidates)::integer as candidate_count,
        candidates::text as candidates_text
      from system.content_search_candidate_snapshots
      where snapshot_id = ${first.ranking.snapshotId}
    `;
    expect(storedSnapshots[0]?.candidate_count).toBeGreaterThan(1);
    expect(storedSnapshots[0]?.candidates_text).not.toContain(cursorToken);

    const second = await searchService.searchContent(null, {
      communityId: cursorCommunityId,
      cursor: first.page.nextCursor,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "hybrid",
      sort: "latest",
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.contentId).not.toBe(first.items[0]?.contentId);
    expect(second.ranking.snapshotId).toBe(first.ranking.snapshotId);
    expect(second.semanticIndexCoverage).toEqual(first.semanticIndexCoverage);

    const snapshotRevisionId = second.items[0]!.snippetSourceRevisionId;
    const updatedAfterSnapshot = await writeService.updateContent(
      authorContext,
      {
        contentId: second.items[0]!.contentId,
        editSummary: "Verify Search cursor Revision projection semantics.",
        expectedVersion: 1,
        idempotencyKey: `search-snapshot-edit-${randomUUID()}`,
        patch: {
          bodyMarkdown: `${cursorToken} was revised only after the Search snapshot.`,
        },
      },
      { channel: "rest", requestId: `req-${randomUUID()}` },
    );
    if (
      updatedAfterSnapshot.status !== "succeeded" ||
      updatedAfterSnapshot.result?.revisionId === null ||
      updatedAfterSnapshot.result?.revisionId === undefined
    ) {
      throw new Error("Content Search snapshot edit fixture failed");
    }
    const continuedAfterEdit = await searchService.searchContent(null, {
      communityId: cursorCommunityId,
      cursor: first.page.nextCursor,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "hybrid",
      sort: "latest",
    });
    expect(continuedAfterEdit.items[0]).toMatchObject({
      contentId: second.items[0]!.contentId,
      contentVersion: 2,
      currentRevisionId: updatedAfterSnapshot.result.revisionId,
      snippetSourceRevisionId: snapshotRevisionId,
    });
    expect(continuedAfterEdit.items[0]!.currentRevisionId).not.toBe(
      continuedAfterEdit.items[0]!.snippetSourceRevisionId,
    );

    const fresh = await searchService.searchContent(null, {
      communityId: cursorCommunityId,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "hybrid",
      sort: "latest",
    });
    const epochsBefore = await postgres.sql<{ epoch_name: string; epoch: string }[]>`
      select epoch_name, epoch::text as epoch
      from system.content_read_visibility_epochs
      order by epoch_name
    `;
    const late = await createPost({
      body: `${cursorToken} arrives only after the cursor snapshot.`,
      communityId: cursorCommunityId,
      title: "Late Search cursor epoch fixture",
    });
    const lateReply = await createReply(
      late.contentId,
      `${cursorToken} reply also arrives after the cursor snapshot.`,
    );
    await insertEmbeddingChunk(cursorContents[2]!.revisionId);
    await insertEmbeddingChunk(late.revisionId);
    const epochsAfter = await postgres.sql<{ epoch_name: string; epoch: string }[]>`
      select epoch_name, epoch::text as epoch
      from system.content_read_visibility_epochs
      order by epoch_name
    `;
    expect(epochsAfter).toEqual(epochsBefore);
    const continuationQueries: string[] = [];
    const embeddingCallsBeforeContinuation = searchEmbeddingCalls.length;
    const previousDebug = postgres.sql.options.debug;
    postgres.sql.options.debug = (_connection, query) => {
      continuationQueries.push(query);
    };
    const continued = await (async () => {
      try {
        return await searchService.searchContent(null, {
          communityId: cursorCommunityId,
          cursor: fresh.page.nextCursor,
          limit: 1,
          query: cursorToken,
          scope: "community",
          searchMode: "hybrid",
          sort: "latest",
        });
      } finally {
        postgres.sql.options.debug = previousDebug;
      }
    })();
    expect(continued.ranking.snapshotId).toBe(fresh.ranking.snapshotId);
    expect(continued.ranking.asOf).toEqual(fresh.ranking.asOf);
    expect(continued.semanticIndexCoverage).toEqual(fresh.semanticIndexCoverage);
    expect(
      continuationQueries.some((query) =>
        query.includes("from system.content_embedding_jobs as job"),
      ),
    ).toBe(false);
    expect(
      continuationQueries.some((query) => query.includes("with query_input as")),
    ).toBe(false);
    expect(
      continuationQueries.some((query) =>
        query.includes("from system.content_search_candidate_snapshots"),
      ),
    ).toBe(true);
    expect(searchEmbeddingCalls).toHaveLength(embeddingCallsBeforeContinuation);
    expect(continued.items.map((item) => item.contentId)).not.toContain(late.contentId);
    expect(continued.items.map((item) => item.contentId)).not.toContain(
      lateReply.contentId,
    );

    const beforeVisibilityChange = await searchService.searchContent(null, {
      communityId: cursorCommunityId,
      limit: 1,
      query: cursorToken,
      scope: "community",
      searchMode: "hybrid",
      sort: "latest",
    });
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${cursorContents[0]!.contentId}::uuid
    `;
    await expect(
      searchService.searchContent(null, {
        communityId: cursorCommunityId,
        cursor: beforeVisibilityChange.page.nextCursor,
        limit: 1,
        query: cursorToken,
        scope: "community",
        searchMode: "hybrid",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED" });

    expect(cursorContents.map((content) => content.contentId)).toContain(
      first.items[0]?.contentId,
    );
  });

  it("atomically reserves and finalizes privacy-safe Agent activity before limiting", async () => {
    const privateQuery = `privateaccountposition${marker}`;
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_value, index) =>
        searchService.searchContent(
          limiterContext,
          {
            query: privateQuery,
            scope: "global",
            searchMode: "lexical",
          },
          { channel: "mcp", requestId: `req-${marker}-${index}` },
        ),
      ),
    );
    const admitted = attempts.filter((attempt) => attempt.status === "fulfilled");
    const limited = attempts.filter((attempt) => attempt.status === "rejected");
    expect(admitted).toHaveLength(10);
    expect(limited).toHaveLength(2);
    for (const attempt of admitted) {
      if (attempt.status === "fulfilled") {
        expect(attempt.value.items).toEqual([]);
      }
    }
    for (const attempt of limited) {
      if (attempt.status === "rejected") {
        expect(attempt.reason as unknown).toMatchObject({
          code: "RATE_LIMITED",
          retryAfterMs: expect.any(Number),
          retryable: true,
          statusCode: 429,
        });
      }
    }

    const rows = await postgres.sql<
      {
        event_count: number;
        finalized_count: number;
        raw_rows: string;
      }[]
    >`
      select
        count(*)::integer as event_count,
        count(*) filter (
          where outcome = 'succeeded'
            and finalized_at is not null
            and result_count = 0
            and latency_ms >= 0
        )::integer as finalized_count,
        jsonb_agg(to_jsonb(event) order by occurred_at, id)::text as raw_rows
      from platform.agent_search_activity_events as event
      where actor_id = ${limiterContext.agent.actorId}::uuid
    `;
    expect(rows[0]?.event_count).toBe(10);
    expect(rows[0]?.finalized_count).toBe(10);
    expect(rows[0]?.raw_rows).not.toContain(privateQuery);

    const digests = await postgres.sql<{ digest: string; size: number }[]>`
      select
        encode(query_hmac, 'hex') as digest,
        octet_length(query_hmac)::integer as size
      from platform.agent_search_activity_events
      where actor_id = ${limiterContext.agent.actorId}::uuid
    `;
    expect(digests).toHaveLength(10);
    expect(new Set(digests.map((row) => row.digest)).size).toBe(1);
    expect(digests.every((row) => row.size === 32)).toBe(true);

    const rawQueryColumns = await postgres.sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'platform'
        and table_name = 'agent_search_activity_events'
        and column_name in (
          'query',
          'query_text',
          'prompt',
          'request_body',
          'result_payload'
        )
    `;
    expect(rawQueryColumns).toEqual([]);
  });

  it("immediately finds the newest microsecond-precision chunk after fenced indexing", async () => {
    const embeddedTexts: string[] = [];
    const provider = deterministicProvider(embeddedTexts);
    const indexer = new SearchIndexer(postgres.sql, provider, {
      tokenFactory: () => Buffer.alloc(32, 37),
    });
    await expect(indexer.checkReady()).resolves.toBeUndefined();
    const now = new Date();
    const event: OutboxEvent = {
      aggregateId: indexContent.contentId,
      aggregateSequence: "1",
      aggregateType: "content",
      attempts: 1,
      eventType: "content.published",
      eventVersion: 1,
      id: randomUUID(),
      leaseExpiresAt: new Date(now.valueOf() + 60_000),
      maxAttempts: 12,
      occurredAt: now,
      payload: { revision_id: indexContent.revisionId },
    };

    await expect(indexer.enqueueOutboxEvent(event)).resolves.toBe(true);
    const ready = await postgres.sql<
      { priority: number; revision_id: string; status: string }[]
    >`
      select priority::integer as priority, revision_id::text as revision_id, status
      from system.content_embedding_jobs
      where revision_id = ${indexContent.revisionId}::uuid
        and embedding_model = ${TITAN_TEXT_EMBED_V2_INDEX_MODEL}
    `;
    expect(ready).toEqual([
      {
        priority: 100,
        revision_id: indexContent.revisionId,
        status: "ready",
      },
    ]);

    // The Revision trigger has already durably queued every fixture, including
    // fixtures created by earlier integration files in the shared CI database.
    // Walk bounded claim pages until this event's job is reached instead of
    // assuming it is among the first 100 globally ordered jobs.
    let targetLease: SearchIndexJobLease | undefined;
    for (let page = 0; page < 10 && targetLease === undefined; page += 1) {
      const leases = await indexer.claimJobs(`search-worker-${marker}`, 100);
      targetLease = leases.find((lease) => lease.revisionId === indexContent.revisionId);
      if (leases.length < 100) break;
    }
    if (targetLease === undefined) {
      throw new Error("Newest Search indexing fixture was not claimable");
    }
    expect(targetLease).toMatchObject({
      attempts: 1,
      embeddingModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      leaseOwner: `search-worker-${marker}`,
      revisionId: indexContent.revisionId,
    });
    await indexer.processJob(targetLease);

    const completed = await postgres.sql<
      {
        chunk_count: number;
        dimensions: number;
        max_end: number;
        min_start: number;
        status: string;
      }[]
    >`
      select
        job.status,
        count(chunk.id)::integer as chunk_count,
        min(chunk.source_start_offset)::integer as min_start,
        max(chunk.source_end_offset)::integer as max_end,
        min(public.vector_dims(chunk.embedding))::integer as dimensions
      from system.content_embedding_jobs as job
      join platform.content_embedding_chunks as chunk
        on chunk.revision_id = job.revision_id
       and chunk.embedding_model = job.embedding_model
      where job.revision_id = ${indexContent.revisionId}::uuid
        and job.embedding_model = ${TITAN_TEXT_EMBED_V2_INDEX_MODEL}
      group by job.status
    `;
    expect(completed).toEqual([
      {
        chunk_count: 1,
        dimensions: 512,
        max_end: expect.any(Number),
        min_start: 0,
        status: "completed",
      },
    ]);
    expect(completed[0]!.max_end).toBeGreaterThan(0);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain(indexToken);
    await expect(
      postgres.sql`
        update platform.content_embedding_chunks
        set token_count = token_count
        where revision_id = ${indexContent.revisionId}::uuid
          and embedding_model = ${TITAN_TEXT_EMBED_V2_INDEX_MODEL}
      `,
    ).rejects.toMatchObject({ code: "55000" });

    const semanticService = new PostgresContentSearchService(postgres.sql, {
      activityDigestKey: Buffer.from(
        "semantic-search-integration-activity-digest-key-v1",
        "utf8",
      ),
      cursorSigningKey: Buffer.from(
        "semantic-search-integration-cursor-signing-key-v1",
        "utf8",
      ),
      embeddingProvider: provider,
    });
    const semantic = await semanticService.searchContent(null, {
      contentTypes: ["post"],
      query: `semanticprobe${marker}`,
      scope: "global",
      searchMode: "semantic",
    });
    expect(semantic.items.map((item) => item.contentId)).toContain(
      indexContent.contentId,
    );
    expect(
      semantic.items.find((item) => item.contentId === indexContent.contentId)
        ?.matchedFields,
    ).toEqual(["semantic"]);
  });

  it("limits semantic latest to bounded relevant candidates and exposes an HNSW plan", async () => {
    const baseTime = Date.now() - 2_000;
    const records = Array.from({ length: 101 }, (_value, index) => {
      const relevant = index < 100;
      return {
        body: relevant
          ? `${boundedSemanticToken} relevant semantic evidence ${index}.`
          : `orthogonal${marker} newest but irrelevant evidence.`,
        content_id: randomUUID(),
        created_at: new Date(baseTime + index).toISOString(),
        embedding: JSON.stringify(relevant ? firstAxisVector : secondAxisVector),
        relevant,
        revision_id: randomUUID(),
        title: relevant
          ? `Relevant semantic fixture ${index}`
          : "Newest irrelevant semantic fixture",
      };
    });

    await postgres.sql.begin(async (transaction) => {
      const json = transaction.json(records);
      await transaction`
        insert into platform.content_items (
          id,
          version,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          parent_id,
          depth,
          current_revision_id,
          lifecycle_state,
          distribution_state,
          erasure_state,
          published_at,
          created_at,
          updated_at
        )
        select
          fixture.content_id::uuid,
          1,
          'post',
          ${authorContext.agent.actorId}::uuid,
          ${semanticCommunityId}::uuid,
          fixture.content_id::uuid,
          null,
          0,
          null,
          'published',
          'normal',
          'retained',
          fixture.created_at::timestamptz,
          fixture.created_at::timestamptz,
          fixture.created_at::timestamptz
        from jsonb_to_recordset(${json}) as fixture(
          content_id text,
          created_at text
        )
      `;
      await transaction`
        insert into platform.content_revisions (
          id,
          content_id,
          revision_number,
          title,
          body_markdown,
          body_plain_text,
          created_by_actor_id,
          created_at,
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        select
          fixture.revision_id::uuid,
          fixture.content_id::uuid,
          1,
          fixture.title,
          fixture.body,
          fixture.body,
          ${authorContext.agent.actorId}::uuid,
          fixture.created_at::timestamptz,
          1,
          decode(repeat('ab', 32), 'hex'),
          1024
        from jsonb_to_recordset(${json}) as fixture(
          revision_id text,
          content_id text,
          title text,
          body text,
          created_at text
        )
      `;
      await transaction`
        update platform.content_items as content
        set current_revision_id = fixture.revision_id::uuid
        from jsonb_to_recordset(${json}) as fixture(
          content_id text,
          revision_id text
        )
        where content.id = fixture.content_id::uuid
          and content.current_revision_id is null
      `;
      await transaction`
        insert into platform.content_embedding_chunks (
          revision_id,
          embedding_model,
          chunk_index,
          source_start_offset,
          source_end_offset,
          source_text_hash,
          token_count,
          embedding,
          created_at
        )
        select
          fixture.revision_id::uuid,
          ${TITAN_TEXT_EMBED_V2_INDEX_MODEL},
          0,
          0,
          char_length(fixture.body),
          decode(repeat('cd', 32), 'hex'),
          greatest(1, ceil(char_length(fixture.body)::numeric / 4)::integer),
          fixture.embedding::vector(512),
          fixture.created_at::timestamptz + interval '456 microseconds'
        from jsonb_to_recordset(${json}) as fixture(
          revision_id text,
          body text,
          embedding text,
          created_at text
        )
      `;
    });

    const provider: TextEmbeddingProvider = {
      dimensions: 512,
      indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      modelId: "amazon.titan-embed-text-v2:0",
      embed: () => Promise.resolve(firstAxisVector),
    };
    const boundedService = new PostgresContentSearchService(postgres.sql, {
      activityDigestKey: Buffer.from(
        "bounded-semantic-integration-activity-key-v1",
        "utf8",
      ),
      cursorSigningKey: Buffer.from("bounded-semantic-integration-cursor-key-v1", "utf8"),
      embeddingProvider: provider,
    });
    const page = await boundedService.searchContent(null, {
      communityId: semanticCommunityId,
      contentTypes: ["post"],
      limit: 5,
      query: boundedSemanticToken,
      scope: "community",
      searchMode: "semantic",
      sort: "latest",
    });
    const relevantIds = new Set<string>(
      records.filter((record) => record.relevant).map((record) => record.content_id),
    );
    const irrelevantId = records.find((record) => !record.relevant)!.content_id;
    expect(page.items).toHaveLength(5);
    expect(page.items.every((item) => relevantIds.has(item.contentId))).toBe(true);
    expect(page.items.map((item) => item.contentId)).not.toContain(irrelevantId);
    expect(page.items[0]?.contentId).toBe(records[99]!.content_id);
    expect(page.items.every((item) => item.matchedFields[0] === "semantic")).toBe(true);
    expect(page.semanticIndexCoverage).toEqual({
      complete: true,
      unindexedCandidateCount: 0,
    });

    const plan = await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe("set local enable_seqscan = off");
      return transaction<{ "QUERY PLAN": unknown }[]>`
        explain (format json)
        select revision_id
        from platform.content_embedding_chunks
        order by embedding <=> ${JSON.stringify(firstAxisVector)}::vector(512)
        limit 100
      `;
    });
    expect(JSON.stringify(plan[0]?.["QUERY PLAN"])).toContain(
      "content_embedding_chunks_cosine_hnsw_idx",
    );
  });
});
