import { createHmac } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import type { AgentCredentialContext } from "./agent-connection.js";
import {
  EmbeddingProviderError,
  TITAN_TEXT_EMBED_V2_INDEX_MODEL,
  type TextEmbeddingProvider,
} from "./bedrock-embedding.js";
import {
  PostgresContentSearchService,
  normalizeContentSearchInput,
} from "./content-search.js";
import type { ContentSearchError } from "./content-search.js";

const now = new Date("2026-07-21T18:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const agentId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const credentialId = "10000000-0000-4000-8000-000000000004";
const policyId = "10000000-0000-4000-8000-000000000005";
const activityId = "20000000-0000-4000-8000-000000000001";
const communityId = "30000000-0000-4000-8000-000000000001";
const contentId = "40000000-0000-4000-8000-000000000001";
const secondContentId = "40000000-0000-4000-8000-000000000002";
const revisionId = "50000000-0000-4000-8000-000000000001";
const secondRevisionId = "50000000-0000-4000-8000-000000000002";
const cursorKey = Buffer.alloc(32, 1);
const activityKey = Buffer.alloc(32, 2);
const cursorSignatureDomain = "alphanet.content-search.cursor-signature.v1";

interface Query {
  text: string;
  values: unknown[];
}

function fakeSql(responder: (query: Query) => unknown[] | Promise<unknown[]>): {
  calls: Query[];
  sql: PostgresClient;
} {
  const calls: Query[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return responder(query);
  };
  Object.assign(tag, {
    begin: async <T>(
      first: string | ((transaction: typeof tag) => Promise<T>),
      second?: (transaction: typeof tag) => Promise<T>,
    ) => {
      const callback = typeof first === "string" ? second : first;
      if (!callback) throw new Error("transaction callback missing");
      return callback(tag);
    },
    json: (value: unknown) => value,
    unsafe: (text: string) => {
      calls.push({ text, values: [] });
      return Promise.resolve([]);
    },
  });
  return { calls, sql: tag as unknown as PostgresClient };
}

function viewer(): AgentCredentialContext {
  return {
    agent: {
      activatedAt: new Date(now.valueOf() - 60 * 60_000),
      actorId,
      archivedAt: null,
      bio: null,
      createdAt: new Date(now.valueOf() - 2 * 60 * 60_000),
      credentialCount: 1,
      discoveryTags: [],
      displayName: "Search Agent",
      handle: "search-agent",
      id: agentId,
      ownerId,
      policy: {
        defaultsVersion: "agent-permission-defaults-v1",
        effectiveFrom: now,
        id: policyId,
        rules: { operations: {} },
        schemaVersion: 1,
        tier: "autonomous",
        version: "1",
      },
      restrictionReasonCode: null,
      status: "active",
      updatedAt: now,
    },
    credential: {
      agentId,
      audience: "urn:alphanet:api:v1",
      expiresAt: null,
      id: credentialId,
      issuedAt: now,
      lastUsedAt: null,
      name: "search",
      ownerId,
      policyCeiling: "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      prefix: "aln_v1_search",
      replacesCredentialId: null,
      revokedAt: null,
      scopes: ["research:read"],
      status: "active",
      type: "static_api_key",
    },
    owner: { id: ownerId },
  };
}

function snapshotRow(cursorTtlMilliseconds = 15 * 60_000) {
  return {
    as_of: now,
    content_epoch: "1",
    database_snapshot: "100:100:",
    expires_at: new Date(now.valueOf() + cursorTtlMilliseconds - 1),
    follow_epoch: null,
    index_as_of: now,
    public_epoch: null,
    search_epoch: "1",
  };
}

function projectionRow() {
  return {
    active_reactions: [],
    actor_id: actorId,
    actor_kind: "agent",
    agent_id: agentId,
    agree_agent_count: 0,
    agree_count: 0,
    agree_human_count: 0,
    author_handle: "search-agent",
    body_markdown: "AMD margin research",
    body_plain_text: "AMD margin research",
    community_ids: [communityId],
    content_id: contentId,
    content_updated_at: new Date(now.valueOf() - 4_000),
    content_version: 2,
    created_at: new Date(now.valueOf() - 10_000),
    current_revision_id: revisionId,
    depth: 0,
    disagree_agent_count: 0,
    disagree_count: 0,
    disagree_human_count: 0,
    following: false,
    helpful_agent_count: 0,
    helpful_count: 0,
    helpful_human_count: 0,
    kind: "post",
    parent_id: null,
    primary_community_id: communityId,
    references: [],
    reply_count: 0,
    revision_id: revisionId,
    root_id: contentId,
    root_title: "AMD margin outlook",
    source_preview: [],
    symbols: ["AMD"],
    title: "AMD margin outlook",
    topics: ["semiconductors"],
  };
}

function standardResponder(query: Query): unknown[] {
  if (query.text.includes("select count(*)::integer as count, min(occurred_at)")) {
    return [{ count: 0, oldest_at: null }];
  }
  if (query.text.includes("insert into platform.agent_search_activity_events")) {
    return [{ id: activityId }];
  }
  if (query.text.includes("update platform.agent_search_activity_events")) {
    return [{ id: activityId }];
  }
  if (query.text.includes("store_content_search_candidate_snapshot")) {
    return [{ stored: true }];
  }
  if (query.text.includes("pg_current_snapshot()")) return [snapshotRow()];
  if (query.text.includes("with query_input as")) return [];
  return [];
}

describe("Content Search normalization", () => {
  it("canonicalizes natural query/filter identities and defaults to both content kinds", () => {
    expect(
      normalizeContentSearchInput({
        query: "  ＡＭＤ   margins  ",
        scope: "symbol",
        symbol: " amd ",
        symbols: ["mu", "AMD"],
        topics: ["Data-Center"],
      }),
    ).toMatchObject({
      contentTypes: ["post", "reply"],
      query: "AMD margins",
      querySymbols: ["AMD"],
      searchMode: "hybrid",
      sort: "relevance",
      symbol: "AMD",
      symbols: ["AMD", "MU"],
      topics: ["data-center"],
    });
  });

  it("rejects blank queries, mismatched scope targets, duplicate filters, and inverted time", () => {
    for (const input of [
      { query: " ", scope: "global" },
      { query: "AMD", scope: "symbol" },
      { query: "AMD", scope: "global", symbol: "AMD" },
      { query: "AMD", scope: "global", symbols: ["AMD", "amd"] },
      { query: "AMD", scope: "global", createdAfter: now, createdBefore: now },
    ]) {
      expect(() => normalizeContentSearchInput(input as never)).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    }
  });

  it("rejects cursors larger than the public contract limit", () => {
    expect(() =>
      normalizeContentSearchInput({
        cursor: "a".repeat(4_097),
        query: "AMD",
        scope: "global",
      }),
    ).toThrow(expect.objectContaining({ code: "CURSOR_INVALID" }));
  });
});

describe("PostgresContentSearchService", () => {
  it("reserves and finalizes Agent activity while degrading only first-page hybrid provider failure", async () => {
    const harness = fakeSql(standardResponder);
    const failingProvider: TextEmbeddingProvider = {
      dimensions: 512,
      indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      modelId: "amazon.titan-embed-text-v2:0",
      embed() {
        return Promise.reject(new EmbeddingProviderError("UNAVAILABLE"));
      },
    };
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
      embeddingProvider: failingProvider,
    });
    const page = await service.searchContent(
      viewer(),
      { query: "AMD secret thesis", scope: "global" },
      { channel: "mcp", requestId: "req-search-1" },
    );
    expect(page.searchExecution).toEqual({
      degraded: true,
      degradationReason: "VECTOR_UNAVAILABLE",
      effectiveMode: "lexical",
      requestedMode: "hybrid",
    });
    const reservation = harness.calls.find((call) =>
      call.text.includes("insert into platform.agent_search_activity_events"),
    );
    expect(reservation?.text).toContain("query_hmac");
    expect(reservation?.text).not.toContain("outcome");
    expect(JSON.stringify(reservation?.values)).not.toContain("AMD secret thesis");
    expect(harness.calls.some((call) => call.text.includes("outcome ="))).toBe(true);
  });

  it("binds a signed cursor to the viewer and normalized query", async () => {
    const harness = fakeSql((query) => {
      const standard = standardResponder(query);
      if (query.text.includes("with query_input as")) {
        return [
          {
            content_id: contentId,
            matched_fields: ["title", "symbols"],
            published_at: new Date(now.valueOf() - 10_000),
            revision_id: revisionId,
            score: 1,
          },
          {
            content_id: secondContentId,
            matched_fields: ["body"],
            published_at: new Date(now.valueOf() - 20_000),
            revision_id: secondRevisionId,
            score: 0.5,
          },
        ];
      }
      if (query.text.includes("from unnest(")) return [projectionRow()];
      return standard;
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });
    const first = await service.searchContent(
      viewer(),
      { limit: 1, query: "AMD", scope: "global", searchMode: "lexical" },
      { channel: "rest", requestId: "req-search-2" },
    );
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    expect(first.items[0]).toMatchObject({
      contentVersion: 2,
      updatedAt: new Date(now.valueOf() - 4_000),
    });
    expect(
      harness.calls.find((call) => call.text.includes("as source_preview"))?.text,
    ).toMatch(/order by source\.position, source\.id\s+limit 3/iu);
    await expect(
      service.searchContent(
        viewer(),
        {
          cursor: first.page.nextCursor,
          limit: 1,
          query: "MU",
          scope: "global",
          searchMode: "lexical",
        },
        { channel: "rest", requestId: "req-search-3" },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ContentSearchError>>({ code: "CURSOR_INVALID" }),
    );
  });

  it("anchors the maximum cursor TTL inside the database one-hour boundary", async () => {
    const maximumTtlMilliseconds = 60 * 60_000;
    const harness = fakeSql((query) => {
      const standard = standardResponder(query);
      if (query.text.includes("pg_current_snapshot()")) {
        return [snapshotRow(maximumTtlMilliseconds)];
      }
      if (query.text.includes("with query_input as")) {
        return [
          {
            content_id: contentId,
            matched_fields: ["title"],
            published_at: new Date(now.valueOf() - 10_000),
            revision_id: revisionId,
            score: 1,
          },
          {
            content_id: secondContentId,
            matched_fields: ["body"],
            published_at: new Date(now.valueOf() - 20_000),
            revision_id: secondRevisionId,
            score: 0.5,
          },
        ];
      }
      if (query.text.includes("from unnest(")) return [projectionRow()];
      return standard;
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
      cursorTtlSeconds: 3_600,
    });

    const page = await service.searchContent(
      viewer(),
      { limit: 1, query: "AMD", scope: "global", searchMode: "lexical" },
      { channel: "rest", requestId: "req-search-maximum-ttl" },
    );

    expect(page.ranking.expiresAt.valueOf() - page.ranking.asOf.valueOf()).toBe(
      maximumTtlMilliseconds - 1,
    );
    const store = harness.calls.find((call) =>
      call.text.includes("store_content_search_candidate_snapshot"),
    );
    expect(store?.values[3]).toEqual(page.ranking.expiresAt);
    expect(store?.values[3]).toEqual(
      new Date(now.valueOf() + maximumTtlMilliseconds - 1),
    );
  });

  it("fails closed when PostgreSQL returns an oversized snapshot", async () => {
    const oversizedSnapshot = `100:100:${Array.from({ length: 1_100 }, () => "1").join(",")}`;
    const harness = fakeSql((query) => {
      if (query.text.includes("pg_current_snapshot()")) {
        return [{ ...snapshotRow(), database_snapshot: oversizedSnapshot }];
      }
      return standardResponder(query);
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });

    await expect(
      service.searchContent(
        viewer(),
        { query: "AMD", scope: "global", searchMode: "lexical" },
        { channel: "rest", requestId: "req-search-large-snapshot" },
      ),
    ).rejects.toMatchObject({ code: "SEARCH_NOT_READY" });
  });

  it("rejects a correctly signed cursor carrying an oversized snapshot", async () => {
    const firstHarness = fakeSql((query) => {
      const standard = standardResponder(query);
      if (query.text.includes("with query_input as")) {
        return [
          {
            content_id: contentId,
            matched_fields: ["title"],
            published_at: new Date(now.valueOf() - 10_000),
            revision_id: revisionId,
            score: 1,
          },
          {
            content_id: secondContentId,
            matched_fields: ["body"],
            published_at: new Date(now.valueOf() - 20_000),
            revision_id: secondRevisionId,
            score: 0.5,
          },
        ];
      }
      if (query.text.includes("from unnest(")) return [projectionRow()];
      return standard;
    });
    const firstService = new PostgresContentSearchService(firstHarness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });
    const first = await firstService.searchContent(
      viewer(),
      { limit: 1, query: "AMD", scope: "global", searchMode: "lexical" },
      { channel: "rest", requestId: "req-search-cursor-seed" },
    );
    const [encoded] = first.page.nextCursor!.split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as {
      databaseSnapshot: string;
    };
    payload.databaseSnapshot = `100:100:${Array.from({ length: 1_100 }, () => "1").join(",")}`;
    const tamperedEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", cursorKey)
      .update(cursorSignatureDomain, "utf8")
      .update("\u0000", "utf8")
      .update(tamperedEncoded, "utf8")
      .digest("base64url");
    const oversizedSnapshotCursor = `${tamperedEncoded}.${signature}`;
    expect(oversizedSnapshotCursor.length).toBeLessThanOrEqual(4_096);

    const continuationHarness = fakeSql(standardResponder);
    const continuationService = new PostgresContentSearchService(
      continuationHarness.sql,
      {
        activityDigestKey: activityKey,
        clock: () => now,
        cursorSigningKey: cursorKey,
      },
    );
    await expect(
      continuationService.searchContent(
        viewer(),
        {
          cursor: oversizedSnapshotCursor,
          limit: 1,
          query: "AMD",
          scope: "global",
          searchMode: "lexical",
        },
        { channel: "rest", requestId: "req-search-large-cursor-snapshot" },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("keeps generated cursors within 4096 bytes at the snapshot size boundary", async () => {
    const boundarySnapshot = `100:100:${"1,".repeat(1_019)}1`;
    expect(Buffer.byteLength(boundarySnapshot, "utf8")).toBeLessThanOrEqual(2_048);
    const harness = fakeSql((query) => {
      if (query.text.includes("pg_current_snapshot()")) {
        return [{ ...snapshotRow(), database_snapshot: boundarySnapshot }];
      }
      if (query.text.includes("with query_input as")) {
        return [
          {
            content_id: contentId,
            matched_fields: ["title"],
            published_at: new Date(now.valueOf() - 10_000),
            revision_id: revisionId,
            score: 1,
          },
          {
            content_id: secondContentId,
            matched_fields: ["body"],
            published_at: new Date(now.valueOf() - 20_000),
            revision_id: secondRevisionId,
            score: 0.5,
          },
        ];
      }
      if (query.text.includes("from unnest(")) return [projectionRow()];
      return standardResponder(query);
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });

    const page = await service.searchContent(
      viewer(),
      { limit: 1, query: "AMD", scope: "global", searchMode: "lexical" },
      { channel: "rest", requestId: "req-search-boundary-cursor" },
    );

    expect(page.page.nextCursor).toEqual(expect.any(String));
    expect(page.page.nextCursor!.length).toBeLessThanOrEqual(4_096);
  });

  it("enforces the new-Agent 10/minute admission before creating a reservation", async () => {
    const harness = fakeSql((query) => {
      if (query.text.includes("select count(*)::integer as count, min(occurred_at)")) {
        return [{ count: 10, oldest_at: new Date(now.valueOf() - 30_000) }];
      }
      return [];
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });
    await expect(
      service.searchContent(
        viewer(),
        { query: "AMD", scope: "global", searchMode: "lexical" },
        { channel: "rest", requestId: "req-search-4" },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 30_000 });
    expect(
      harness.calls.some((call) =>
        call.text.includes("insert into platform.agent_search_activity_events"),
      ),
    ).toBe(false);
  });

  it("does not turn a successful read into an error when activity finalization fails", async () => {
    const harness = fakeSql((query) => {
      if (query.text.includes("update platform.agent_search_activity_events")) {
        throw Object.assign(new Error("temporary database failure"), { code: "08006" });
      }
      return standardResponder(query);
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
    });

    await expect(
      service.searchContent(
        viewer(),
        { query: "AMD", scope: "global", searchMode: "lexical" },
        { channel: "rest", requestId: "req-search-finalize" },
      ),
    ).resolves.toMatchObject({ items: [], searchExecution: { degraded: false } });
  });

  it("discloses scope-filtered semantic index gaps for hybrid Search", async () => {
    const provider: TextEmbeddingProvider = {
      dimensions: 512,
      indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      modelId: "amazon.titan-embed-text-v2:0",
      embed: () => Promise.resolve(Array.from({ length: 512 }, () => 0.125)),
    };
    const harness = fakeSql((query) => {
      if (
        query.text.includes("select count(*)::integer as count") &&
        !query.text.includes("min(occurred_at)")
      ) {
        return [{ count: 3 }];
      }
      return standardResponder(query);
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
      embeddingProvider: provider,
    });

    const page = await service.searchContent(
      viewer(),
      {
        query: "AMD",
        scope: "global",
        searchMode: "hybrid",
      },
      { channel: "rest", requestId: "req-search-coverage" },
    );
    expect(page.semanticIndexCoverage).toEqual({
      complete: false,
      unindexedCandidateCount: 3,
    });
    expect(page.searchExecution).toMatchObject({
      degraded: false,
      effectiveMode: "hybrid",
    });
    const candidateQuery = harness.calls.find((call) =>
      call.text.includes("with query_input as materialized"),
    );
    expect(candidateQuery?.text).toContain("lexical_score desc nulls last");
    expect(candidateQuery?.text).toContain("lexical_document_matches as materialized");
    expect(candidateQuery?.text).toContain(
      "select revision_id from lexical_symbol_matches",
    );
    expect(candidateQuery?.text).toContain(
      "select revision_id from lexical_topic_matches",
    );
    expect(candidateQuery?.text).toContain(
      "select revision_id from lexical_author_matches",
    );
    expect(candidateQuery?.text).toMatch(/ts_filter\(\s*selected\.search_document/iu);
    expect(candidateQuery?.text).not.toContain("revision.body_plain_text,");
    expect(candidateQuery?.text).not.toContain(
      "to_tsvector('simple'::regconfig, selected.body_plain_text)",
    );
    expect(candidateQuery?.text).not.toMatch(
      /search_document\s*@@\s*query_input\.query\s+or/iu,
    );
    const coverageQuery = harness.calls.find(
      (call) =>
        call.text.includes("from system.content_embedding_jobs as job") &&
        call.text.includes("select count(*)::integer as count"),
    );
    expect(coverageQuery?.text).toContain("job.status <> 'completed'");
    expect(coverageQuery?.text).toContain(
      "not exists (\n          select 1 from platform.content_embedding_chunks as chunk",
    );
  });

  it("freezes semantic coverage in a signed cursor instead of recounting on continuation", async () => {
    let embeddingCalls = 0;
    const provider: TextEmbeddingProvider = {
      dimensions: 512,
      indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      modelId: "amazon.titan-embed-text-v2:0",
      embed: () => {
        embeddingCalls += 1;
        return Promise.resolve(Array.from({ length: 512 }, () => 0.125));
      },
    };
    let coverageQueries = 0;
    let candidateQueries = 0;
    let frozenCandidates: unknown = null;
    const harness = fakeSql((query) => {
      if (query.text.includes("store_content_search_candidate_snapshot")) {
        frozenCandidates = query.values[2];
        return [{ stored: true }];
      }
      if (query.text.includes("from system.content_search_candidate_snapshots")) {
        return [{ candidates: frozenCandidates }];
      }
      if (
        query.text.includes("from system.content_embedding_jobs as job") &&
        query.text.includes("select count(*)::integer as count")
      ) {
        coverageQueries += 1;
        return [{ count: coverageQueries === 1 ? 3 : 99 }];
      }
      if (query.text.includes("with query_input as")) {
        candidateQueries += 1;
        return [
          {
            content_id: contentId,
            matched_fields: ["body", "semantic"],
            published_at: new Date(now.valueOf() - 10_000),
            revision_id: revisionId,
            score: 1,
          },
          {
            content_id: secondContentId,
            matched_fields: ["body"],
            published_at: new Date(now.valueOf() - 20_000),
            revision_id: secondRevisionId,
            score: 0.5,
          },
        ];
      }
      if (query.text.includes("from unnest(")) {
        return JSON.stringify(query.values).includes(secondRevisionId)
          ? [
              {
                ...projectionRow(),
                content_id: secondContentId,
                current_revision_id: secondRevisionId,
                revision_id: secondRevisionId,
                root_id: secondContentId,
              },
            ]
          : [projectionRow()];
      }
      return standardResponder(query);
    });
    const service = new PostgresContentSearchService(harness.sql, {
      activityDigestKey: activityKey,
      clock: () => now,
      cursorSigningKey: cursorKey,
      embeddingProvider: provider,
    });
    const input = {
      limit: 1,
      query: "AMD",
      scope: "global" as const,
      searchMode: "hybrid" as const,
    };

    const first = await service.searchContent(viewer(), input, {
      channel: "rest",
      requestId: "req-search-frozen-coverage-1",
    });
    expect(first.semanticIndexCoverage).toEqual({
      complete: false,
      unindexedCandidateCount: 3,
    });
    expect(first.page.nextCursor).toEqual(expect.any(String));

    const second = await service.searchContent(
      viewer(),
      { ...input, cursor: first.page.nextCursor },
      { channel: "rest", requestId: "req-search-frozen-coverage-2" },
    );
    expect(second.semanticIndexCoverage).toEqual({
      complete: false,
      unindexedCandidateCount: 3,
    });
    expect(coverageQueries).toBe(1);
    expect(candidateQueries).toBe(1);
    expect(embeddingCalls).toBe(1);
    expect(second.items[0]?.contentId).toBe(secondContentId);
    const hydrationQuery = harness.calls.find((query) =>
      query.text.includes("from unnest("),
    );
    expect(hydrationQuery?.text).toContain("left(revision.body_markdown, 601)");
    expect(hydrationQuery?.text).toContain("left(revision.body_plain_text, 601)");
  });
});
