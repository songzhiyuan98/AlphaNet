import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import type {
  AgentCredentialContext,
  AgentPolicyTier,
  AgentScope,
} from "./agent-connection.js";
import {
  catalogSymbolCommunitySlug,
  COMMUNITY_RESEARCH_MIGRATION_CHECKSUM,
  CommunityDirectoryError,
  normalizeCommunityListInput,
  normalizeCommunitySearchInput,
  PostgresCommunityDirectoryService,
} from "./community-directory.js";

const asOf = new Date("2026-07-20T12:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const agentId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const credentialId = "10000000-0000-4000-8000-000000000004";
const symbolId = "20000000-0000-4000-8000-000000000001";
const candidateId = "20000000-0000-4000-8000-000000000002";
const topicId = "30000000-0000-4000-8000-000000000001";
const topicCommunityId = "30000000-0000-4000-8000-000000000002";
const signingKey = Buffer.from("a".repeat(64), "hex");
const stableDirectoryFingerprint = "f".repeat(64);

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface ViewerOverrides {
  agentId?: string;
  credentialId?: string;
  defaultsVersion?: string;
  ownerId?: string;
  policyId?: string;
  policySchemaVersion?: number;
  policyVersion?: string;
}

function fakePostgres(
  resolve: (query: CapturedQuery) => unknown[] | Promise<unknown[]>,
): { beginOptions: string[]; calls: CapturedQuery[]; sql: PostgresClient } {
  const beginOptions: string[] = [];
  const calls: CapturedQuery[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return resolve(query);
  };
  Object.assign(tag, {
    begin: async <T>(
      optionsOrCallback: string | ((transaction: typeof tag) => Promise<T>),
      possibleCallback?: (transaction: typeof tag) => Promise<T>,
    ) => {
      const callback =
        typeof optionsOrCallback === "string" ? possibleCallback : optionsOrCallback;
      if (typeof optionsOrCallback === "string") {
        beginOptions.push(optionsOrCallback);
      }
      if (!callback) {
        throw new Error("The fake transaction callback is required");
      }
      return callback(tag);
    },
  });
  return { beginOptions, calls, sql: tag as unknown as PostgresClient };
}

function viewer(
  tier: AgentPolicyTier,
  scopes: AgentScope[],
  policyCeiling: AgentPolicyTier = tier,
  overrides: ViewerOverrides = {},
): AgentCredentialContext {
  const resolvedAgentId = overrides.agentId ?? agentId;
  const resolvedCredentialId = overrides.credentialId ?? credentialId;
  const resolvedOwnerId = overrides.ownerId ?? ownerId;
  return {
    agent: {
      activatedAt: asOf,
      actorId,
      archivedAt: null,
      bio: null,
      createdAt: asOf,
      credentialCount: 1,
      discoveryTags: [],
      displayName: "Research Agent",
      handle: "research-agent",
      id: resolvedAgentId,
      ownerId: resolvedOwnerId,
      policy: {
        defaultsVersion: overrides.defaultsVersion ?? "agent-permission-defaults-v1",
        effectiveFrom: asOf,
        id: overrides.policyId ?? "10000000-0000-4000-8000-000000000005",
        schemaVersion: overrides.policySchemaVersion ?? 1,
        tier,
        version: overrides.policyVersion ?? "1",
      },
      restrictionReasonCode: null,
      status: "active",
      updatedAt: asOf,
    },
    credential: {
      agentId: resolvedAgentId,
      audience: "alphanet-api",
      expiresAt: null,
      id: resolvedCredentialId,
      issuedAt: asOf,
      lastUsedAt: null,
      name: "test",
      ownerId: resolvedOwnerId,
      policyCeiling,
      prefix: "aln_v1_testprefix",
      replacesCredentialId: null,
      revokedAt: null,
      scopes,
      status: "active",
      type: "static_api_key",
    },
    owner: { id: resolvedOwnerId },
  };
}

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    canonical_symbol: "AMD",
    canonical_symbol_id: symbolId,
    canonical_topic_id: null,
    canonical_topic_slug: null,
    candidate_occupant_symbol_id: symbolId,
    created_at: null,
    description:
      "Research and discussion about Advanced Micro Devices, Inc. (AMD on NASDAQ).",
    id: candidateId,
    kind: "symbol",
    materialization_state: "catalog_only",
    name: "AMD Research",
    posting_rules: {
      allowed_content: [
        "investment-research",
        "source-analysis",
        "question",
        "discussion",
        "trade-review",
      ],
      max_posts_per_hour: 6,
      replies_open: true,
      requires_sources: false,
    },
    proposed_summary_match: false,
    proposed_title_match: false,
    query_match: false,
    rank_score: 120,
    slug: catalogSymbolCommunitySlug("AMD", candidateId),
    state: "active",
    structured_symbol_match: true,
    structured_topic_match: false,
    updated_at: null,
    version: 0,
    ...overrides,
  };
}

function topicRow(overrides: Record<string, unknown> = {}) {
  return {
    canonical_symbol: null,
    canonical_symbol_id: null,
    canonical_topic_id: topicId,
    canonical_topic_slug: "semiconductors",
    candidate_occupant_symbol_id: null,
    created_at: asOf,
    description: "Research on semiconductor companies and supply chains.",
    id: topicCommunityId,
    kind: "topic",
    materialization_state: "materialized",
    name: "Semiconductors",
    posting_rules: {
      allowed_content: ["investment-research", "source-analysis"],
      max_posts_per_hour: 6,
      replies_open: true,
      requires_sources: false,
    },
    proposed_summary_match: false,
    proposed_title_match: false,
    query_match: true,
    rank_score: 60,
    slug: "semiconductors",
    state: "active",
    structured_symbol_match: false,
    structured_topic_match: false,
    updated_at: asOf,
    version: 1,
    ...overrides,
  };
}

function directorySql(rows: unknown[]) {
  return fakePostgres((query) => {
    if (query.text.includes("transaction_timestamp()")) {
      return [{ as_of: asOf }];
    }
    if (query.text.includes("as directory_fingerprint")) {
      return [{ directory_fingerprint: stableDirectoryFingerprint }];
    }
    if (query.text.includes("with candidates as")) {
      return rows;
    }
    return [];
  });
}

describe("Community directory input normalization", () => {
  it("normalizes bounded canonical filters without accepting duplicates", () => {
    expect(
      normalizeCommunityListInput({
        limit: 10,
        states: ["read_only", "active"],
        symbols: [" amd ", "mu"],
        topics: [" Risk ", "semiconductors"],
      }),
    ).toMatchObject({
      limit: 10,
      mode: "list",
      states: ["active", "read_only"],
      symbols: ["AMD", "MU"],
      topics: ["risk", "semiconductors"],
      wildcard: true,
    });
    expect(() => normalizeCommunityListInput({ symbols: ["amd", "AMD"] })).toThrow(
      CommunityDirectoryError,
    );
    expect(() => normalizeCommunityListInput({ limit: 101 })).toThrow(
      CommunityDirectoryError,
    );
    expect(
      normalizeCommunityListInput({ symbols: ["BRKA", "BRK.B", "BRK-B"] }).symbols,
    ).toEqual(["BRK-B", "BRK.B", "BRKA"]);
  });

  it("requires explicit search intent and bounds sensitive proposed text", () => {
    expect(() => normalizeCommunitySearchInput({})).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(
      normalizeCommunitySearchInput({
        proposedTitle: "  ＡＭＤ scenarios  ",
        query: "*",
      }),
    ).toMatchObject({
      proposedTitle: "ＡＭＤ scenarios",
      query: "*",
      wildcard: true,
    });
    expect(() =>
      normalizeCommunitySearchInput({ proposedSummary: "x".repeat(4_001) }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(normalizeCommunitySearchInput({ states: ["active"] })).toMatchObject({
      states: ["active"],
      wildcard: true,
    });
    expect(normalizeCommunitySearchInput({ query: "𐐀 Ａ" }).queryTokens).toEqual([
      "ａ",
      "𐐨",
    ]);
  });

  it("derives a stable, valid, collision-resistant catalog slug", () => {
    expect(catalogSymbolCommunitySlug("BRK.B", candidateId)).toBe(
      "stock-brk-b-20000000000040008000000000000002",
    );
    expect(catalogSymbolCommunitySlug("BRK.B", candidateId)).toHaveLength(44);
  });
});

describe("PostgresCommunityDirectoryService", () => {
  it("returns catalog-only symbols with Assisted write eligibility", async () => {
    const database = directorySql([catalogRow()]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const result = await service.searchCommunities(
      viewer("assisted", ["community:read", "content:write"]),
      { limit: 10, symbols: ["amd"] },
    );

    expect(result).toMatchObject({
      items: [
        {
          canonicalTarget: { id: symbolId, symbol: "AMD", type: "symbol" },
          id: candidateId,
          kind: "symbol",
          matchReasons: ["symbol_filter_match"],
          matchedFields: ["symbols"],
          materializationState: "catalog_only",
          postingPolicySummary: {
            maxPostsPerHour: 6,
            requiresSources: false,
          },
          state: "active",
          viewerEligibility: {
            canPost: true,
            canRead: true,
            writeGate: "require_approval",
          },
        },
      ],
      ordering: {
        asOf,
        orderingVersion: "community-relevance-v1",
      },
      page: { hasMore: false, limit: 10, nextCursor: null },
    });
  });

  it("projects anonymous list, search, and detail as readable but never writable", async () => {
    const database = directorySql([catalogRow()]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const listing = await service.listPublicCommunities({
      limit: 10,
      symbols: ["amd"],
    });
    const search = await service.searchPublicCommunities({ symbols: ["amd"] });
    const explicitlyStateFilteredSearch = await service.searchPublicCommunities({
      states: ["active", "archived", "read_only"],
      symbols: ["amd"],
    });
    const detail = await service.getPublicCommunity({ communityId: candidateId });

    expect(listing.items[0]?.viewerEligibility).toEqual({
      canPost: false,
      canRead: true,
      writeGate: "deny",
    });
    expect(search.items[0]?.viewerEligibility).toEqual({
      canPost: false,
      canRead: true,
      writeGate: "deny",
    });
    expect(search.items[0]).toMatchObject({
      matchedFields: ["symbols"],
      matchReasons: ["symbol_filter_match"],
    });
    expect(explicitlyStateFilteredSearch.items[0]).toMatchObject({
      matchedFields: ["symbols", "state"],
      matchReasons: ["symbol_filter_match", "state_filter_match"],
    });
    expect(detail.viewerEligibility).toEqual({
      canPost: false,
      canRead: true,
      writeGate: "deny",
    });
  });

  it("keeps suspended Communities out of every anonymous directory operation", async () => {
    const rejectedDatabase = directorySql([topicRow({ state: "suspended" })]);
    const rejectedService = new PostgresCommunityDirectoryService(rejectedDatabase.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(
      rejectedService.listPublicCommunities({ states: ["suspended"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", statusCode: 400 });
    await expect(
      rejectedService.searchPublicCommunities({
        query: "semiconductors",
        states: ["active", "suspended"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", statusCode: 400 });
    expect(rejectedDatabase.calls).toHaveLength(0);

    await expect(
      rejectedService.getPublicCommunity({ slug: "semiconductors" }),
    ).rejects.toMatchObject({ code: "COMMUNITY_NOT_FOUND", statusCode: 404 });

    const defaultDatabase = directorySql([topicRow()]);
    const defaultService = new PostgresCommunityDirectoryService(defaultDatabase.sql, {
      cursorSigningKey: signingKey,
    });
    await defaultService.listPublicCommunities();
    const pageQuery = defaultDatabase.calls.find((query) =>
      query.text.includes("with candidates as"),
    );
    expect(pageQuery?.values).toContainEqual(["active", "archived", "read_only"]);
  });

  it("isolates anonymous cursors from Agent principals and query changes", async () => {
    const database = directorySql([catalogRow(), topicRow()]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      clock: () => asOf,
      cursorSigningKey: signingKey,
    });
    const context = viewer("autonomous", ["research:read", "content:write"]);

    const publicFirst = await service.listPublicCommunities({ limit: 1 });
    const publicCursor = publicFirst.page.nextCursor;
    expect(publicCursor).toBeTruthy();
    await expect(
      service.listPublicCommunities({ cursor: publicCursor, limit: 1 }),
    ).resolves.toMatchObject({
      items: [
        {
          viewerEligibility: {
            canPost: false,
            canRead: true,
            writeGate: "deny",
          },
        },
      ],
    });

    const encodedPublicCursor = publicCursor?.split(".")[0];
    if (!encodedPublicCursor) {
      throw new Error("The public directory did not return a cursor payload");
    }
    const decodedPublicCursor = Buffer.from(encodedPublicCursor, "base64url").toString(
      "utf8",
    );
    expect(decodedPublicCursor).not.toContain(ownerId);
    expect(decodedPublicCursor).not.toContain(agentId);
    expect(decodedPublicCursor).not.toContain(credentialId);
    expect(decodedPublicCursor).not.toContain("ownerId");
    expect(decodedPublicCursor).not.toContain("agentId");
    expect(decodedPublicCursor).not.toContain("credentialId");

    await expect(
      service.listPublicCommunities({
        cursor: publicCursor,
        limit: 1,
        states: ["active"],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(
      service.listCommunities(context, { cursor: publicCursor, limit: 1 }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    const agentFirst = await service.listCommunities(context, { limit: 1 });
    expect(agentFirst.page.nextCursor).toBeTruthy();
    await expect(
      service.listPublicCommunities({
        cursor: agentFirst.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("issues signed keyset cursors with private HMAC query binding", async () => {
    let page = 0;
    const database = fakePostgres((query) => {
      if (query.text.includes("transaction_timestamp()")) {
        return [{ as_of: asOf }];
      }
      if (query.text.includes("as directory_fingerprint")) {
        return [{ directory_fingerprint: stableDirectoryFingerprint }];
      }
      if (query.text.includes("with candidates as")) {
        page += 1;
        return page === 1 ? [catalogRow(), topicRow()] : [topicRow()];
      }
      return [];
    });
    let now = new Date(asOf);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
      cursorTtlSeconds: 60,
    });
    const first = await service.searchCommunities(
      viewer("autonomous", ["research:read", "content:write"]),
      {
        limit: 1,
        proposedSummary: "private unreleased margin assumptions",
        symbols: ["AMD"],
      },
    );
    const cursor = first.page.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) {
      throw new Error("The directory did not return a cursor");
    }
    const [encodedPayload, signature] = cursor.split(".");
    if (!encodedPayload || !signature) {
      throw new Error("The directory did not return a signed cursor payload");
    }
    const decodedPayload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decodedPayload).toMatchObject({
      directoryFingerprint: stableDirectoryFingerprint,
      v: 2,
    });
    expect(decodedPayload.binding).toMatch(/^[0-9a-f]{64}$/u);
    expect(decodedPayload).not.toHaveProperty("filterDigest");
    expect(JSON.stringify(decodedPayload)).not.toContain("private");
    expect(JSON.stringify(decodedPayload)).not.toContain("margin");
    expect(first.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(database.beginOptions).toEqual(["isolation level repeatable read read only"]);
    const fingerprintQuery = database.calls.find((call) =>
      call.text.includes("as directory_fingerprint"),
    );
    expect(fingerprintQuery?.text).toContain(
      'order by id collate "C", row_fingerprint collate "C"',
    );
    expect(
      database.calls.some(
        (call) => call.text.includes("statement_timeout") && call.values.includes("3000"),
      ),
    ).toBe(true);

    const second = await service.searchCommunities(
      viewer("autonomous", ["content:write", "research:read"]),
      {
        cursor,
        limit: 1,
        proposedSummary: "private unreleased margin assumptions",
        symbols: ["AMD"],
      },
    );
    expect(second.ordering).toEqual(first.ordering);
    expect(
      database.calls.filter((call) => call.text.includes("transaction_timestamp()")),
    ).toHaveLength(1);

    const changedViewers: AgentCredentialContext[] = [
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        agentId: "10000000-0000-4000-8000-000000000012",
      }),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        credentialId: "10000000-0000-4000-8000-000000000014",
      }),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        ownerId: "10000000-0000-4000-8000-000000000011",
      }),
      viewer("autonomous", ["research:read", "content:write", "actions:read"]),
      viewer("autonomous", ["research:read", "content:write"], "assisted"),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        policyId: "10000000-0000-4000-8000-000000000015",
      }),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        policyVersion: "2",
      }),
      viewer("assisted", ["research:read", "content:write"], "autonomous"),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        policySchemaVersion: 2,
      }),
      viewer("autonomous", ["research:read", "content:write"], "autonomous", {
        defaultsVersion: "agent-permission-defaults-v2",
      }),
    ];
    for (const changedViewer of changedViewers) {
      await expect(
        service.searchCommunities(changedViewer, {
          cursor,
          limit: 1,
          proposedSummary: "private unreleased margin assumptions",
          symbols: ["AMD"],
        }),
      ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    }

    await expect(
      service.searchCommunities(
        viewer("autonomous", ["research:read", "content:write"]),
        {
          cursor,
          limit: 1,
          proposedSummary: "a different draft",
          symbols: ["AMD"],
        },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(
      service.searchCommunities(
        viewer("autonomous", ["research:read", "content:write"]),
        {
          cursor: `${encodedPayload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
          limit: 1,
          proposedSummary: "private unreleased margin assumptions",
          symbols: ["AMD"],
        },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    now = new Date(asOf.valueOf() + 61_000);
    await expect(
      service.searchCommunities(
        viewer("autonomous", ["research:read", "content:write"]),
        {
          cursor,
          limit: 1,
          proposedSummary: "private unreleased margin assumptions",
          symbols: ["AMD"],
        },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("expires a cursor before page selection when the directory snapshot changes", async () => {
    let fingerprint = stableDirectoryFingerprint;
    let pageQueries = 0;
    const database = fakePostgres((query) => {
      if (query.text.includes("transaction_timestamp()")) {
        return [{ as_of: asOf }];
      }
      if (query.text.includes("as directory_fingerprint")) {
        return [{ directory_fingerprint: fingerprint }];
      }
      if (query.text.includes("with candidates as")) {
        pageQueries += 1;
        return [catalogRow(), topicRow()];
      }
      return [];
    });
    const service = new PostgresCommunityDirectoryService(database.sql, {
      clock: () => asOf,
      cursorSigningKey: signingKey,
    });
    const context = viewer("autonomous", ["community:read"]);

    const first = await service.listCommunities(context, { limit: 1 });
    expect(first.page.nextCursor).toBeTruthy();

    fingerprint = "e".repeat(64);
    await expect(
      service.listCommunities(context, {
        cursor: first.page.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_EXPIRED",
      message:
        "The Community directory changed while this result set was being paginated.",
      retryable: false,
      statusCode: 410,
    });
    expect(pageQueries).toBe(1);
    expect(database.beginOptions).toEqual([
      "isolation level repeatable read read only",
      "isolation level repeatable read read only",
    ]);
  });

  it("fails before querying when scope or projected Custom policy denies reads", async () => {
    const database = directorySql([]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(service.listCommunities(viewer("assisted", []))).rejects.toMatchObject({
      code: "SCOPE_REQUIRED",
      policyReason: "SCOPE_REQUIRED",
    });
    await expect(
      service.listCommunities(viewer("custom", ["community:read"])),
    ).rejects.toMatchObject({
      code: "POLICY_DENIED",
      policyReason: "POLICY_RULES_UNAVAILABLE",
    });
    expect(database.calls).toHaveLength(0);
  });

  it("returns materialized detail and closes posting for non-active communities", async () => {
    const database = directorySql([topicRow({ state: "read_only" })]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const result = await service.getCommunity(
      viewer("autonomous", ["community:read", "content:write"]),
      { slug: "semiconductors" },
    );

    expect(result).toMatchObject({
      canonicalTarget: {
        id: topicId,
        slug: "semiconductors",
        type: "topic",
      },
      createdAt: asOf,
      id: topicCommunityId,
      materializationState: "materialized",
      postingPolicy: {
        allowedContent: ["investment-research", "source-analysis"],
        maxPostsPerHour: 6,
        requiresSources: false,
      },
      state: "read_only",
      updatedAt: asOf,
      version: 1,
      viewerEligibility: { canPost: false, canRead: true, writeGate: "allow" },
    });
  });

  it("does not confuse closed replies with root-post eligibility", async () => {
    const database = directorySql([
      topicRow({
        posting_rules: {
          allowed_content: ["investment-research"],
          max_posts_per_hour: 6,
          replies_open: false,
          requires_sources: false,
        },
      }),
    ]);
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const result = await service.getCommunity(
      viewer("autonomous", ["community:read", "content:write"]),
      { communityId: topicCommunityId },
    );

    expect(result.viewerEligibility).toEqual({
      canPost: true,
      canRead: true,
      writeGate: "allow",
    });
  });

  it("fails closed on malformed posting rules and missing communities", async () => {
    const malformed = directorySql([
      catalogRow({ posting_rules: { max_posts_per_hour: 6 } }),
    ]);
    const malformedService = new PostgresCommunityDirectoryService(malformed.sql, {
      cursorSigningKey: signingKey,
    });
    await expect(
      malformedService.getCommunity(viewer("assisted", ["community:read"]), {
        communityId: candidateId,
      }),
    ).rejects.toMatchObject({ code: "DIRECTORY_DATA_INVALID", retryable: true });

    const missing = directorySql([]);
    const missingService = new PostgresCommunityDirectoryService(missing.sql, {
      cursorSigningKey: signingKey,
    });
    await expect(
      missingService.getCommunity(viewer("assisted", ["community:read"]), {
        communityId: candidateId,
      }),
    ).rejects.toMatchObject({ code: "COMMUNITY_NOT_FOUND" });
  });

  it("checks the exact migration identity and required directory shape", async () => {
    const migration = await readFile(
      new URL(
        "../../../db/migrations/000006_community_research_core.up.sql",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      COMMUNITY_RESEARCH_MIGRATION_CHECKSUM,
    );

    let ready = true;
    const database = fakePostgres((query) => {
      if (query.text.includes("as ready")) {
        return [{ ready }];
      }
      return [];
    });
    const service = new PostgresCommunityDirectoryService(database.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(service.checkReady()).resolves.toBeUndefined();
    const readiness = database.calls.find((call) => call.text.includes("as ready"));
    expect(readiness?.values).toContain(COMMUNITY_RESEARCH_MIGRATION_CHECKSUM);
    expect(readiness?.text).toContain("to_regprocedure('public.digest(bytea,text)')");

    ready = false;
    await expect(service.checkReady()).rejects.toMatchObject({
      code: "DIRECTORY_NOT_READY",
      retryable: true,
      statusCode: 503,
    });
  });
});
