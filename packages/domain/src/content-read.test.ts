import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import type {
  AgentCredentialContext,
  AgentPolicyTier,
  AgentScope,
} from "./agent-connection.js";
import {
  ContentReadError,
  normalizeContentBrowseInput,
  normalizeDiscussionInput,
  PostgresContentReadService,
} from "./content-read.js";

const now = new Date("2026-07-20T20:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const agentId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";
const credentialId = "10000000-0000-4000-8000-000000000004";
const policyId = "10000000-0000-4000-8000-000000000005";
const communityId = "20000000-0000-4000-8000-000000000001";
const rootId = "30000000-0000-4000-8000-000000000001";
const replyId = "30000000-0000-4000-8000-000000000002";
const secondReplyId = "30000000-0000-4000-8000-000000000003";
const revisionId = "40000000-0000-4000-8000-000000000001";
const replyRevisionId = "40000000-0000-4000-8000-000000000002";
const secondRevisionId = "40000000-0000-4000-8000-000000000003";
const thirdRevisionId = "40000000-0000-4000-8000-000000000004";
const fourthRevisionId = "40000000-0000-4000-8000-000000000005";
const signingKey = Buffer.from("content-read-unit-signing-key-material-v1", "utf8");

interface CapturedQuery {
  text: string;
  values: unknown[];
}

function fakePostgres(
  responder: (query: CapturedQuery) => unknown[] | Promise<unknown[]>,
): { calls: CapturedQuery[]; sql: PostgresClient } {
  const calls: CapturedQuery[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    if (query.text.includes("pg_current_snapshot()")) {
      return [{ database_snapshot: "100:100:" }];
    }
    return responder(query);
  };
  Object.assign(tag, {
    begin: async <T>(
      optionsOrCallback: string | ((transaction: typeof tag) => Promise<T>),
      possibleCallback?: (transaction: typeof tag) => Promise<T>,
    ) => {
      const callback =
        typeof optionsOrCallback === "string" ? possibleCallback : optionsOrCallback;
      if (!callback) throw new Error("A transaction callback is required");
      return callback(tag);
    },
  });
  return { calls, sql: tag as unknown as PostgresClient };
}

function viewer(
  scopes: AgentScope[],
  tier: AgentPolicyTier = "autonomous",
): AgentCredentialContext {
  return {
    agent: {
      activatedAt: now,
      actorId,
      archivedAt: null,
      bio: null,
      createdAt: now,
      credentialCount: 1,
      discoveryTags: [],
      displayName: "Reader Agent",
      handle: "reader-agent",
      id: agentId,
      ownerId,
      policy: {
        defaultsVersion: "agent-permission-defaults-v1",
        effectiveFrom: now,
        id: policyId,
        rules: { operations: {} },
        schemaVersion: 1,
        tier,
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
      name: "reader",
      ownerId,
      policyCeiling: tier,
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      prefix: "aln_v1_reader",
      replacesCredentialId: null,
      revokedAt: null,
      scopes,
      status: "active",
      type: "static_api_key",
    },
    owner: { id: ownerId },
  };
}

function projectionRow(
  options: {
    body?: string;
    deleted?: boolean;
    following?: boolean;
    id?: string;
    kind?: "post" | "reply";
    parentId?: string | null;
    revisionId?: string;
    revisionNumber?: number;
    title?: string;
  } = {},
) {
  const kind = options.kind ?? "post";
  const id = options.id ?? rootId;
  const deleted = options.deleted ?? false;
  const body = options.body ?? "Independent research body with evidence.";
  const selectedRevisionId = options.revisionId ?? revisionId;
  return {
    active_reactions: [],
    actor_id: actorId,
    actor_kind: "agent",
    agree_agent_count: 0,
    agree_count: 0,
    agree_human_count: 0,
    additional_community_ids: kind === "post" ? [] : [],
    agent_id: agentId,
    author_handle: "reader-agent",
    body_markdown: deleted ? null : body,
    body_plain_text: deleted ? null : body,
    content_hash: deleted ? null : "a".repeat(64),
    created_at: new Date(now.valueOf() - 10_000),
    current_revision_id: deleted ? null : selectedRevisionId,
    deleted_at: deleted ? now : null,
    depth: kind === "post" ? 0 : 1,
    disagree_agent_count: 0,
    disagree_count: 0,
    disagree_human_count: 0,
    distribution_state: "normal",
    edit_summary: null,
    effective_community_ids: [communityId],
    erasure_state: "retained",
    helpful_agent_count: 0,
    helpful_count: 0,
    helpful_human_count: 0,
    id,
    inbound_reference_count: 0,
    kind,
    last_activity_at: now,
    lifecycle_state: deleted ? "deleted" : "published",
    following: options.following ?? false,
    mentions: [],
    parent_id: kind === "post" ? null : (options.parentId ?? rootId),
    primary_community_id: kind === "post" ? communityId : null,
    published_at: new Date(now.valueOf() - 10_000),
    public_node_serialized_bytes: deleted ? null : 512,
    references: [],
    reply_count: kind === "post" ? 2 : 0,
    revision_created_at: deleted ? null : new Date(now.valueOf() - 10_000),
    revision_created_by_actor_id: deleted ? null : actorId,
    revision_id: deleted ? null : selectedRevisionId,
    revision_number: deleted ? null : (options.revisionNumber ?? 1),
    revision_title: deleted
      ? null
      : kind === "post"
        ? (options.title ?? "A valid research title")
        : null,
    root_id: rootId,
    source_links: [],
    source_version: deleted ? null : 1,
    symbols: ["AMD"],
    topics: ["semiconductors"],
    updated_at: now,
    version: deleted ? 2 : 1,
  };
}

describe("content read input normalization", () => {
  it("normalizes scope targets and stable filters", () => {
    expect(
      normalizeContentBrowseInput({
        authorActorIds: [actorId],
        contentTypes: ["reply", "post"],
        createdAfter: "2026-07-01T00:00:00Z",
        scope: "symbol",
        sort: "active",
        symbol: " amd ",
        symbols: ["mu", "AMD"],
        topics: [" Semiconductors "],
      }),
    ).toMatchObject({
      authorActorIds: [actorId],
      contentTypes: ["post", "reply"],
      scope: "symbol",
      sort: "active",
      symbol: "AMD",
      symbols: ["AMD", "MU"],
      topics: ["semiconductors"],
    });
  });

  it("rejects ambiguous scopes, duplicate filters, and impossible ranges", () => {
    expect(() => normalizeContentBrowseInput({ scope: "community" })).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(() =>
      normalizeContentBrowseInput({
        communityId,
        scope: "community",
        symbol: "AMD",
      }),
    ).toThrow(ContentReadError);
    expect(() =>
      normalizeContentBrowseInput({ scope: "global", symbols: ["AMD", "amd"] }),
    ).toThrow(ContentReadError);
    expect(() =>
      normalizeContentBrowseInput({
        createdAfter: "2026-07-20T00:00:00Z",
        createdBefore: "2026-07-19T00:00:00Z",
        scope: "global",
      }),
    ).toThrow(ContentReadError);
  });

  it("accepts a targetless Following scope and remembers whether content types were explicit", () => {
    expect(normalizeContentBrowseInput({ scope: "following" })).toMatchObject({
      contentTypes: ["post"],
      contentTypesExplicit: false,
      scope: "following",
    });
    expect(
      normalizeContentBrowseInput({
        contentTypes: ["post"],
        scope: "following",
      }),
    ).toMatchObject({
      contentTypes: ["post"],
      contentTypesExplicit: true,
      scope: "following",
    });
    expect(() =>
      normalizeContentBrowseInput({ scope: "following", symbol: "AMD" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("bounds discussion pages so every persisted node can make progress", () => {
    expect(
      normalizeDiscussionInput({ contentId: replyId, sort: "latest" }),
    ).toMatchObject({
      byteBudget: 1_048_576,
      contentId: replyId,
      limit: 20,
      sort: "latest",
    });
    expect(() =>
      normalizeDiscussionInput({ byteBudget: 786_431, contentId: replyId }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("PostgresContentReadService", () => {
  it("enforces research:read before touching PostgreSQL", async () => {
    const database = fakePostgres(() => []);
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(
      service.browseContent(viewer(["actions:read"]), {
        scope: "global",
      }),
    ).rejects.toMatchObject({
      code: "SCOPE_REQUIRED",
      policyReason: "SCOPE_REQUIRED",
      statusCode: 403,
    });
    expect(database.calls).toHaveLength(0);
  });

  it("rejects anonymous Following reads before touching PostgreSQL", async () => {
    const database = fakePostgres(() => []);
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(
      service.browseContent(null, { scope: "following" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", statusCode: 400 });
    expect(database.calls).toHaveLength(0);
  });

  it("issues private signed keyset cursors and binds them to viewer and query", async () => {
    let pageQueries = 0;
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("content_read_visibility_epochs")) {
        return [
          {
            content_membership_epoch: "1",
            public_community_visibility_epoch: null,
          },
        ];
      }
      if (query.text.includes("candidates as (")) {
        pageQueries += 1;
        return pageQueries === 1
          ? [
              {
                created_at: new Date(now.valueOf() - 10_000),
                id: rootId,
                matched_follows: [],
                order_at: new Date(now.valueOf() - 10_000),
              },
              {
                created_at: new Date(now.valueOf() - 20_000),
                id: secondReplyId,
                matched_follows: [],
                order_at: new Date(now.valueOf() - 20_000),
              },
            ]
          : [
              {
                created_at: new Date(now.valueOf() - 20_000),
                id: secondReplyId,
                matched_follows: [],
                order_at: new Date(now.valueOf() - 20_000),
              },
            ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [projectionRow()];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
      cursorTtlSeconds: 60,
    });
    const context = viewer(["research:read"]);

    const first = await service.browseContent(context, {
      limit: 1,
      scope: "global",
      sort: "latest",
    });
    expect(first.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(first.items[0]).toMatchObject({
      contentId: rootId,
      rank: 1,
      selectionReasons: ["scope:global", "sort:latest"],
    });
    const cursor = first.page.nextCursor;
    expect(cursor).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(cursor!.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(decoded.binding).toMatch(/^[0-9a-f]{64}$/u);
    expect(decoded).toMatchObject({
      databaseSnapshot: "100:100:",
      followEpoch: null,
      v: 4,
      visibilityEpoch: "content:1",
    });
    expect(JSON.stringify(decoded)).not.toContain(agentId);
    expect(JSON.stringify(decoded)).not.toContain(credentialId);

    await expect(
      service.browseContent(null, {
        cursor,
        limit: 1,
        scope: "global",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(
      service.browseContent(context, {
        cursor,
        limit: 1,
        scope: "global",
        sort: "active",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    const [payload, signature] = cursor!.split(".");
    const tampered = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    await expect(
      service.browseContent(context, {
        cursor: `${payload}.${tampered}`,
        limit: 1,
        scope: "global",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("expires a continuation instead of reusing a mutated content snapshot", async () => {
    let epochReads = 0;
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("content_read_visibility_epochs")) {
        epochReads += 1;
        return [
          {
            content_membership_epoch: String(epochReads),
            public_community_visibility_epoch: null,
          },
        ];
      }
      if (query.text.includes("candidates as (")) {
        return [
          {
            created_at: new Date(now.valueOf() - 10_000),
            id: rootId,
            matched_follows: [],
            order_at: new Date(now.valueOf() - 10_000),
          },
          {
            created_at: new Date(now.valueOf() - 20_000),
            id: secondReplyId,
            matched_follows: [],
            order_at: new Date(now.valueOf() - 20_000),
          },
        ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [projectionRow()];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
      cursorTtlSeconds: 60,
    });
    const context = viewer(["research:read"]);
    const first = await service.browseContent(context, {
      limit: 1,
      scope: "global",
      sort: "active",
    });

    await expect(
      service.browseContent(context, {
        cursor: first.page.nextCursor,
        limit: 1,
        scope: "global",
        sort: "active",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("projects all canonical Following matches, direct content state, and active three-key cursors", async () => {
    const matchedFollows = [
      {
        notificationLevel: "all_events",
        targetId: rootId,
        targetType: "content",
      },
      {
        notificationLevel: "new_posts",
        targetId: actorId,
        targetType: "actor",
      },
      {
        notificationLevel: "feed_only",
        targetId: "AMD",
        targetType: "symbol",
      },
      {
        notificationLevel: "feed_only",
        targetId: "semiconductors",
        targetType: "topic",
      },
    ] as const;
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("actor_follow_epochs")) return [{ follow_epoch: "7" }];
      if (query.text.includes("content_read_visibility_epochs")) {
        return [
          {
            content_membership_epoch: "3",
            public_community_visibility_epoch: null,
          },
        ];
      }
      if (query.text.includes("candidates as (")) {
        return [
          {
            created_at: new Date(now.valueOf() - 10_000),
            id: rootId,
            matched_follows: matchedFollows,
            order_at: new Date(now.valueOf() - 1_000),
          },
          {
            created_at: new Date(now.valueOf() - 20_000),
            id: secondReplyId,
            matched_follows: matchedFollows,
            order_at: new Date(now.valueOf() - 2_000),
          },
        ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [projectionRow({ following: true })];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
      cursorTtlSeconds: 60,
    });

    const page = await service.browseContent(viewer(["research:read"]), {
      limit: 1,
      scope: "following",
      sort: "active",
    });

    expect(page.ranking.rankingVersion).toBe("following-active-v1");
    expect(page.items[0]).toMatchObject({
      contentId: rootId,
      matchedFollows,
      viewerState: { following: true, reactions: [] },
    });
    const decoded = JSON.parse(
      Buffer.from(page.page.nextCursor!.split(".")[0]!, "base64url").toString("utf8"),
    ) as {
      followEpoch: string;
      last: { createdAt: string };
    };
    expect(decoded.followEpoch).toBe("7");
    expect(decoded.last.createdAt).toBe(new Date(now.valueOf() - 10_000).toISOString());
    const candidateQuery = database.calls.find((query) =>
      query.text.includes("candidates as ("),
    );
    expect(candidateQuery?.text).toContain("(order_at, created_at, id)");
    expect(candidateQuery?.text).toContain(
      "content.parent_id = follow.target_content_id",
    );
    expect(candidateQuery?.text).toContain("content.root_id = follow.target_content_id");
    expect(candidateQuery?.text).toContain("content.id = follow.target_content_id");
    expect(candidateQuery?.text).toContain("direct_content_follow");
    await expect(
      service.browseContent(viewer(["research:read"]), {
        contentTypes: ["post"],
        cursor: page.page.nextCursor,
        limit: 1,
        scope: "following",
        sort: "active",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("expires only a Following continuation when the current Actor epoch changes", async () => {
    let followEpochReads = 0;
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("actor_follow_epochs")) {
        followEpochReads += 1;
        return [{ follow_epoch: String(followEpochReads) }];
      }
      if (query.text.includes("content_read_visibility_epochs")) {
        return [
          {
            content_membership_epoch: "1",
            public_community_visibility_epoch: null,
          },
        ];
      }
      if (query.text.includes("candidates as (")) {
        return [
          {
            created_at: new Date(now.valueOf() - 10_000),
            id: rootId,
            matched_follows: [
              {
                notificationLevel: "feed_only",
                targetId: rootId,
                targetType: "content",
              },
            ],
            order_at: new Date(now.valueOf() - 10_000),
          },
          {
            created_at: new Date(now.valueOf() - 20_000),
            id: secondReplyId,
            matched_follows: [
              {
                notificationLevel: "feed_only",
                targetId: rootId,
                targetType: "content",
              },
            ],
            order_at: new Date(now.valueOf() - 20_000),
          },
        ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [projectionRow()];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
      cursorTtlSeconds: 60,
    });
    const context = viewer(["research:read"]);
    const first = await service.browseContent(context, {
      limit: 1,
      scope: "following",
      sort: "latest",
    });

    await expect(
      service.browseContent(context, {
        cursor: first.page.nextCursor,
        limit: 1,
        scope: "following",
        sort: "latest",
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });
  });

  it("returns stable deleted tombstones without revision payload", async () => {
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("select\n        content.id::text as id")) {
        return [projectionRow({ deleted: true })];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const detail = await service.getContent(null, {
      contentId: rootId,
      includeRevisionHistory: true,
      revisionId,
      revisionLimit: 10,
    });
    expect(detail).toMatchObject({
      content: {
        currentRevisionId: null,
        lifecycleState: "deleted",
        symbols: [],
        title: null,
        topics: [],
      },
      revision: null,
    });
    expect(detail).not.toHaveProperty("revisionHistory");
    expect(JSON.stringify(detail)).not.toContain("Independent research body");
    expect(
      database.calls.some(
        (query) =>
          query.text.includes("as selected_revision") ||
          query.text.includes("as history_revision"),
      ),
    ).toBe(false);
  });

  it("selects a historical revision without changing canonical current content", async () => {
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("select\n        content.id::text as id")) {
        return [
          projectionRow({
            revisionId: thirdRevisionId,
            revisionNumber: 3,
            title: "Current canonical research title",
          }),
        ];
      }
      if (query.text.includes("as selected_revision")) {
        return [
          {
            body_markdown: "Historical thesis with its original evidence.",
            body_plain_text: "Historical thesis with its original evidence.",
            content_hash: "b".repeat(64),
            content_id: rootId,
            content_kind: "post",
            created_at: new Date(now.valueOf() - 20_000),
            created_by_actor_id: actorId,
            edit_summary: "Initial thesis",
            id: revisionId,
            mentions: [],
            public_node_serialized_bytes: 512,
            references: [{ relationType: "reference", targetContentId: replyId }],
            revision_number: 1,
            source_links: [
              {
                addedAt: new Date(now.valueOf() - 20_000).toISOString(),
                addedByActorId: actorId,
                addedRevisionId: revisionId,
                description: null,
                sourceLinkId: "50000000-0000-4000-8000-000000000001",
                title: "Original filing",
                url: "https://example.com/filing",
              },
            ],
            source_version: 1,
            title: "Original research title",
          },
        ];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const detail = await service.getContent(null, {
      contentId: rootId,
      revisionId,
    });

    expect(detail.content).toMatchObject({
      currentRevisionId: thirdRevisionId,
      title: "Current canonical research title",
      version: 1,
    });
    expect(detail.revision).toMatchObject({
      contentId: rootId,
      id: revisionId,
      references: [{ relationType: "reference", targetContentId: replyId }],
      revisionNumber: 1,
      sourceLinks: [expect.objectContaining({ title: "Original filing" })],
      title: "Original research title",
    });
    const revisionQuery = database.calls.find((query) =>
      query.text.includes("as selected_revision"),
    );
    expect(revisionQuery?.text).toContain("added_revision.revision_number <=");
    expect(revisionQuery?.text).toContain("removed_revision.revision_number >");
    expect(revisionQuery?.values).toEqual(expect.arrayContaining([rootId, revisionId]));
  });

  it("rejects a revision that does not belong to the visible content", async () => {
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("select\n        content.id::text as id"))
        return [projectionRow()];
      if (query.text.includes("as selected_revision")) return [];
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    await expect(
      service.getContent(null, { contentId: rootId, revisionId: secondRevisionId }),
    ).rejects.toMatchObject({ code: "REVISION_NOT_FOUND", statusCode: 404 });
  });

  it("paginates immutable revision metadata in descending order with a bound cursor", async () => {
    let historyQueryCount = 0;
    let currentRevisionId = thirdRevisionId;
    let currentRevisionNumber = 3;
    let visibilityEpoch = "1";
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("content_read_visibility_epochs")) {
        return [
          {
            content_membership_epoch: visibilityEpoch,
            public_community_visibility_epoch: visibilityEpoch,
          },
        ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [
          projectionRow({
            revisionId: currentRevisionId,
            revisionNumber: currentRevisionNumber,
          }),
        ];
      }
      if (query.text.includes("as history_revision")) {
        historyQueryCount += 1;
        return historyQueryCount === 1
          ? [
              {
                content_hash: "c".repeat(64),
                content_id: rootId,
                created_at: now,
                created_by_actor_id: actorId,
                edit_summary: "Third",
                id: thirdRevisionId,
                revision_number: 3,
                source_version: 3,
              },
              {
                content_hash: "b".repeat(64),
                content_id: rootId,
                created_at: new Date(now.valueOf() - 1_000),
                created_by_actor_id: actorId,
                edit_summary: "Second",
                id: secondRevisionId,
                revision_number: 2,
                source_version: 2,
              },
            ]
          : [
              {
                content_hash: "b".repeat(64),
                content_id: rootId,
                created_at: new Date(now.valueOf() - 1_000),
                created_by_actor_id: actorId,
                edit_summary: "Second",
                id: secondRevisionId,
                revision_number: 2,
                source_version: 2,
              },
            ];
      }
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      clock: () => now,
      cursorSigningKey: signingKey,
    });

    const first = await service.getContent(null, {
      contentId: rootId,
      includeRevisionHistory: true,
      revisionLimit: 1,
    });
    expect(first.revisionHistory?.map((item) => item.revisionNumber)).toEqual([3]);
    expect(first.revisionPage).toMatchObject({ hasMore: true, limit: 1 });
    expect(first.revisionOrdering).toMatchObject({
      asOf: now,
      orderingVersion: "revision-history-desc-v1",
    });

    currentRevisionId = fourthRevisionId;
    currentRevisionNumber = 4;
    const second = await service.getContent(null, {
      contentId: rootId,
      includeRevisionHistory: true,
      revisionCursor: first.revisionPage?.nextCursor,
      revisionLimit: 1,
    });
    expect(second.content.currentRevisionId).toBe(fourthRevisionId);
    expect(second.revisionHistory?.map((item) => item.revisionNumber)).toEqual([2]);
    expect(second.revisionPage).toEqual({ hasMore: false, limit: 1, nextCursor: null });
    expect(second.revisionOrdering?.snapshotId).toBe(first.revisionOrdering?.snapshotId);
    const continuationQuery = database.calls.filter((query) =>
      query.text.includes("as history_revision"),
    )[1];
    expect(continuationQuery?.values).toContain(3);
    expect(continuationQuery?.values).not.toContain(4);

    await expect(
      service.getContent(viewer(["research:read"]), {
        contentId: rootId,
        includeRevisionHistory: true,
        revisionCursor: first.revisionPage?.nextCursor,
        revisionLimit: 1,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 400 });

    visibilityEpoch = "2";
    await expect(
      service.getContent(null, {
        contentId: rootId,
        includeRevisionHistory: true,
        revisionCursor: first.revisionPage?.nextCursor,
        revisionLimit: 1,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_EXPIRED", statusCode: 410 });

    await expect(
      service.getContent(null, {
        contentId: rootId,
        includeRevisionHistory: true,
        revisionCursor: first.revisionPage?.nextCursor,
        revisionLimit: 2,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 400 });
  });

  it("returns a flat ordered discussion and truncates on the byte budget", async () => {
    const database = fakePostgres((query) => {
      if (query.text.includes("set_config")) return [];
      if (query.text.includes("transaction_timestamp()")) return [{ as_of: now }];
      if (query.text.includes("content_read_visibility_epochs")) {
        return [
          {
            content_membership_epoch: "1",
            public_community_visibility_epoch: "1",
          },
        ];
      }
      if (query.text.includes("requested.id::text as id")) {
        return [
          {
            depth: 1,
            id: replyId,
            kind: "reply",
            parent_id: rootId,
            root_id: rootId,
          },
        ];
      }
      if (query.text.includes("as serialized_bytes")) {
        return [
          {
            id: replyId,
            order_at: new Date(now.valueOf() - 5_000),
            serialized_bytes: 600_000,
          },
          {
            id: secondReplyId,
            order_at: new Date(now.valueOf() - 4_000),
            serialized_bytes: 600_000,
          },
        ];
      }
      if (query.text.includes("select\n        content.id::text as id")) {
        return [
          projectionRow(),
          projectionRow({
            body: "x".repeat(200_000),
            id: replyId,
            kind: "reply",
            revisionId: replyRevisionId,
          }),
          projectionRow({
            body: "y".repeat(200_000),
            id: secondReplyId,
            kind: "reply",
            revisionId: replyRevisionId,
          }),
        ];
      }
      if (query.text.includes("with recursive ancestor_chain")) return [];
      return [];
    });
    const service = new PostgresContentReadService(database.sql, {
      cursorSigningKey: signingKey,
    });

    const discussion = await service.getDiscussion(null, {
      byteBudget: 786_432,
      contentId: replyId,
      limit: 2,
      sort: "oldest",
    });
    expect(discussion.root.id).toBe(rootId);
    expect(discussion.replies.map((reply) => reply.id)).toEqual([replyId]);
    expect(discussion.replies[0]).toMatchObject({
      depth: 1,
      parentContentId: rootId,
      rootContentId: rootId,
    });
    expect(discussion.page).toMatchObject({
      hasMore: true,
      limit: 2,
      truncatedByByteBudget: true,
    });
    expect(discussion.page.nextCursor).toBeTruthy();
  });
});
