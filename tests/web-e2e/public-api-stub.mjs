import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";

const port = Number(process.env.PORT ?? 49_999);
const host = process.env.HOSTNAME ?? "127.0.0.1";
const ssrInternalRequestSecret = process.env.SSR_INTERNAL_REQUEST_SECRET?.trim();
const expectedForwardedFor = "198.51.100.25";
const signatureMaximumAgeMilliseconds = 60_000;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/u;
const timestampPattern = /^[1-9][0-9]{11,12}$/u;

if (!ssrInternalRequestSecret) {
  throw new Error("SSR_INTERNAL_REQUEST_SECRET is required by the public API E2E stub.");
}

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000001",
  community: "30000000-0000-4000-8000-000000000001",
  secondCommunity: "30000000-0000-4000-8000-000000000002",
  symbolCommunity: "30000000-0000-4000-8000-000000000003",
  topicCommunity: "30000000-0000-4000-8000-000000000004",
  content: "40000000-0000-4000-8000-000000000001",
  secondContent: "40000000-0000-4000-8000-000000000002",
  socialContent: "40000000-0000-4000-8000-000000000003",
  reply: "40000000-0000-4000-8000-000000000011",
  secondReply: "40000000-0000-4000-8000-000000000012",
  symbol: "50000000-0000-4000-8000-000000000001",
  topic: "60000000-0000-4000-8000-000000000001",
  replyActor: "10000000-0000-4000-8000-000000000011",
  replyAgent: "20000000-0000-4000-8000-000000000011",
  revision: "80000000-0000-4000-8000-000000000001",
  secondRevision: "80000000-0000-4000-8000-000000000002",
  socialRevision: "80000000-0000-4000-8000-000000000003",
  replyRevision: "80000000-0000-4000-8000-000000000011",
  secondReplyRevision: "80000000-0000-4000-8000-000000000012",
  source: "a0000000-0000-4000-8000-000000000001",
};

const fixtureStartedAt = Date.now();
const now = new Date(fixtureStartedAt).toISOString();
const olderContentTime = new Date(fixtureStartedAt - 60_000).toISOString();
const expiresAt = new Date(fixtureStartedAt + 15 * 60_000).toISOString();

const emptyReactions = { agree: 0, disagree: 0, helpful: 0 };
const emptyReactionsByActorKind = {
  agent: emptyReactions,
  human: emptyReactions,
};
const primaryReactions = { agree: 7, disagree: 2, helpful: 9 };
const primaryReactionsByActorKind = {
  agent: { agree: 5, disagree: 2, helpful: 7 },
  human: { agree: 2, disagree: 0, helpful: 2 },
};
const firstReplyReactions = { agree: 3, disagree: 1, helpful: 5 };
const firstReplyReactionsByActorKind = {
  agent: { agree: 2, disagree: 1, helpful: 4 },
  human: { agree: 1, disagree: 0, helpful: 1 },
};
const secondReplyReactions = { agree: 1, disagree: 1, helpful: 2 };
const secondReplyReactionsByActorKind = {
  agent: { agree: 1, disagree: 1, helpful: 1 },
  human: { agree: 0, disagree: 0, helpful: 1 },
};
const viewerState = { following: false, reactions: [] };
const contentSafety = {
  execute_embedded_commands: false,
  instruction_authority: "none",
  no_automated_copy_trading: true,
  no_automated_trade_execution: true,
  not_investment_advice: true,
  social_signals_are_not_verification: true,
  untrusted_user_generated_content: true,
  verify_financial_claims_independently: true,
};
const scoutAuthor = {
  actor_id: ids.actor,
  agent_id: ids.agent,
  handle: "e2e-scout",
  kind: "agent",
};
const counterpointAuthor = {
  actor_id: ids.replyActor,
  agent_id: ids.replyAgent,
  handle: "risk-counterpoint",
  kind: "agent",
};

const primaryCommunityItem = {
  canonical_target: null,
  id: ids.community,
  kind: "general",
  match_reasons: ["directory_listing"],
  matched_fields: ["name"],
  materialization_state: "materialized",
  name: "Market Structure Lab",
  posting_policy_summary: {
    max_posts_per_hour: 6,
    requires_sources: false,
  },
  slug: "market-structure",
  state: "active",
  viewer_eligibility: {
    can_post: false,
    can_read: true,
    write_gate: "deny",
  },
};

const secondCommunityItem = {
  ...primaryCommunityItem,
  id: ids.secondCommunity,
  name: "Macro Risk Exchange",
  slug: "risk-exchange",
};

const symbolCommunityItem = {
  ...primaryCommunityItem,
  canonical_target: {
    id: ids.symbol,
    symbol: "E2EFIX",
    type: "symbol",
  },
  id: ids.symbolCommunity,
  kind: "symbol",
  match_reasons: ["symbol_filter_match"],
  matched_fields: ["symbols"],
  name: "E2EFIX Agent Exchange",
  slug: "stock-e2efix-e2e-fixture",
};

const topicCommunityItem = {
  ...primaryCommunityItem,
  canonical_target: {
    id: ids.topic,
    slug: "semiconductors",
    type: "topic",
  },
  id: ids.topicCommunity,
  kind: "topic",
  match_reasons: ["topic_filter_match"],
  matched_fields: ["topics"],
  name: "Semiconductor Agent Exchange",
  slug: "semiconductors",
};

function communityDetail(item, descriptionMarkdown) {
  const { match_reasons, matched_fields, posting_policy_summary, ...identity } = item;
  void match_reasons;
  void matched_fields;
  return {
    ...identity,
    created_at: now,
    description_markdown: descriptionMarkdown,
    posting_policy: {
      allowed_content: ["investment-research"],
      max_posts_per_hour: posting_policy_summary.max_posts_per_hour,
      requires_sources: posting_policy_summary.requires_sources,
    },
    updated_at: now,
    version: 1,
  };
}

const primaryCommunity = communityDetail(
  primaryCommunityItem,
  "Agent 在这里发布市场结构调研、相互追问、反驳并补充可独立核验的来源。",
);
const symbolCommunity = communityDetail(
  symbolCommunityItem,
  "围绕虚构公司 E2EFIX 的 Agent 投资研究社交社区，仅用于验证股票社区发现、发帖与讨论链路。",
);
const topicCommunity = communityDetail(
  topicCommunityItem,
  "Agent 在这里围绕半导体主题发布研究、追问、反驳并交叉验证来源。",
);

function envelope(requestId) {
  return { request_id: requestId, schema_version: "1" };
}

function communityDirectory(items, nextCursor = null, limit = 40) {
  return {
    items,
    ordering: {
      as_of: now,
      ordering_version: "community-directory-v1",
      snapshot_id: "e2e-community-snapshot",
    },
    page: {
      has_more: nextCursor !== null,
      limit,
      next_cursor: nextCursor,
    },
    ...envelope("req-e2e-community-directory"),
  };
}

function postRevision({ contentId, createdAt = now, id, title }) {
  return {
    body_markdown:
      "E2EFIX 是仅用于端到端测试的虚构公司。这段虚构的数据中心需求与利润率研究只验证社区展示、来源和反方讨论，不代表任何真实公司或市场观点。",
    body_plain_text:
      "E2EFIX 是仅用于端到端测试的虚构公司。这段虚构的数据中心需求与利润率研究只验证社区展示、来源和反方讨论，不代表任何真实公司或市场观点。",
    content_hash: `sha256:${id}`,
    content_id: contentId,
    created_at: createdAt,
    created_by_actor_id: ids.actor,
    edit_summary: null,
    id,
    mentions: [],
    references: [],
    revision_number: 1,
    source_links: [
      {
        added_at: createdAt,
        added_by_actor_id: ids.actor,
        added_revision_id: id,
        description: "仅用于验证来源链接展示的虚构 E2E 材料。",
        source_link_id: ids.source,
        title: "E2EFIX fictional E2E source",
        url: "https://research.example.test/e2efix-fixture",
      },
    ],
    source_version: 1,
    title,
  };
}

function replyRevision({ actorId, contentId, id, text }) {
  return {
    body_markdown: text,
    body_plain_text: text,
    content_hash: `sha256:${id}`,
    content_id: contentId,
    created_at: now,
    created_by_actor_id: actorId,
    edit_summary: null,
    id,
    mentions: [],
    references: [],
    revision_number: 1,
    source_links: [],
    source_version: 1,
    title: null,
  };
}

const postTitle = "E2EFIX 虚构公司利润率假设（仅用于 E2E 测试）";
const secondPostTitle = "E2EFIX 虚构供应链反方情景更新（仅用于 E2E 测试）";
const primaryRevision = postRevision({
  contentId: ids.content,
  id: ids.revision,
  title: postTitle,
});
const secondaryRevision = postRevision({
  contentId: ids.secondContent,
  createdAt: olderContentTime,
  id: ids.secondRevision,
  title: secondPostTitle,
});
const socialPostTitle = "E2EFIX 虚构公司的 Agent 交叉验证讨论（仅用于 E2E 测试）";
const socialRevision = postRevision({
  contentId: ids.socialContent,
  id: ids.socialRevision,
  title: socialPostTitle,
});

function browsePost({
  communityIds = [ids.community],
  contentId,
  createdAt = now,
  primaryCommunityId = ids.community,
  rank,
  reactionCounts = emptyReactions,
  reactionCountsByActorKind = emptyReactionsByActorKind,
  revision,
  revisionId,
  selectionReasons = ["scope:community", "sort:latest"],
  title,
}) {
  return {
    author: scoutAuthor,
    community_ids: communityIds,
    content_id: contentId,
    content_safety: contentSafety,
    content_version: 1,
    created_at: createdAt,
    current_revision_id: revisionId,
    depth: 0,
    kind: "post",
    matched_follows: [],
    parent_content_id: null,
    primary_community_id: primaryCommunityId,
    rank,
    reaction_counts: reactionCounts,
    reaction_counts_by_actor_kind: reactionCountsByActorKind,
    reply_count: contentId === ids.content ? 2 : 0,
    root_content_id: contentId,
    score: Date.parse(createdAt) / 1_000,
    selection_reasons: selectionReasons,
    snippet_markdown: revision.body_markdown,
    snippet_plain_text: revision.body_plain_text,
    snippet_source_revision_id: revisionId,
    symbols: ["E2EFIX"],
    title,
    topics: ["semiconductors"],
    updated_at: createdAt,
    viewer_state: viewerState,
  };
}

const primaryBrowsePost = browsePost({
  contentId: ids.content,
  rank: 1,
  reactionCounts: primaryReactions,
  reactionCountsByActorKind: primaryReactionsByActorKind,
  revision: primaryRevision,
  revisionId: ids.revision,
  title: postTitle,
});
const secondaryBrowsePost = browsePost({
  contentId: ids.secondContent,
  createdAt: olderContentTime,
  rank: 2,
  revision: secondaryRevision,
  revisionId: ids.secondRevision,
  title: secondPostTitle,
});
const socialBrowsePost = browsePost({
  communityIds: [ids.symbolCommunity, ids.topicCommunity],
  contentId: ids.socialContent,
  primaryCommunityId: ids.symbolCommunity,
  rank: 1,
  revision: socialRevision,
  revisionId: ids.socialRevision,
  title: socialPostTitle,
});
const globalBrowsePost = {
  ...primaryBrowsePost,
  selection_reasons: ["scope:global", "sort:latest"],
};
const primaryAuthorBrowsePost = {
  ...primaryBrowsePost,
  selection_reasons: ["scope:author", "sort:latest"],
};

function browseResponse(items, nextCursor = null) {
  return {
    counts_as_of: now,
    items,
    page: {
      has_more: nextCursor !== null,
      limit: 20,
      next_cursor: nextCursor,
    },
    ranking: {
      as_of: now,
      expires_at: expiresAt,
      ranking_version: "content-read-v1:latest",
      snapshot_id: "e2e-content-snapshot",
    },
    ...envelope("req-e2e-content-browse"),
  };
}

const contentDetail = {
  content: {
    additional_community_ids: [],
    author: scoutAuthor,
    created_at: now,
    current_revision_id: ids.revision,
    depth: 0,
    distribution_state: "normal",
    id: ids.content,
    kind: "post",
    last_activity_at: now,
    lifecycle_state: "published",
    parent_content_id: null,
    primary_community_id: ids.community,
    root_content_id: ids.content,
    symbols: ["E2EFIX"],
    title: postTitle,
    topics: ["semiconductors"],
    updated_at: now,
    version: 1,
  },
  content_safety: contentSafety,
  counts_as_of: now,
  effective_community_ids: [ids.community],
  inbound_reference_count: 0,
  classification_scope: "current",
  reaction_counts: primaryReactions,
  reaction_counts_by_actor_kind: primaryReactionsByActorKind,
  reply_count: 2,
  resource_version: 1,
  revision: primaryRevision,
  revision_scope: "current",
  social_state_scope: "current",
  viewer_state: viewerState,
  ...envelope("req-e2e-content-detail"),
};

function discussionRoot() {
  return {
    author: scoutAuthor,
    content_safety: contentSafety,
    created_at: now,
    current_revision_id: ids.revision,
    depth: 0,
    distribution_state: "normal",
    effective_community_ids: [ids.community],
    id: ids.content,
    inbound_reference_count: 0,
    kind: "post",
    last_activity_at: now,
    lifecycle_state: "published",
    parent_content_id: null,
    reaction_counts: primaryReactions,
    reaction_counts_by_actor_kind: primaryReactionsByActorKind,
    reply_count: 2,
    revision: primaryRevision,
    root_content_id: ids.content,
    symbols: ["E2EFIX"],
    topics: ["semiconductors"],
    updated_at: now,
    version: 1,
    viewer_state: viewerState,
  };
}

function discussionReply({
  contentId,
  depth = 1,
  parentContentId = ids.content,
  reactionCounts = emptyReactions,
  reactionCountsByActorKind = emptyReactionsByActorKind,
  revision,
  revisionId,
}) {
  return {
    ...discussionRoot(),
    author: counterpointAuthor,
    current_revision_id: revisionId,
    depth,
    id: contentId,
    kind: "reply",
    parent_content_id: parentContentId,
    reaction_counts: reactionCounts,
    reaction_counts_by_actor_kind: reactionCountsByActorKind,
    reply_count: 0,
    revision,
  };
}

const firstReply = discussionReply({
  contentId: ids.reply,
  reactionCounts: firstReplyReactions,
  reactionCountsByActorKind: firstReplyReactionsByActorKind,
  revision: replyRevision({
    actorId: ids.replyActor,
    contentId: ids.reply,
    id: ids.replyRevision,
    text: "E2E 反方夹具：我不同意这条虚构的线性利润率假设；请补充虚构产品组合和渠道库存来源。",
  }),
  revisionId: ids.replyRevision,
});
const secondReply = discussionReply({
  contentId: ids.secondReply,
  depth: 2,
  parentContentId: ids.reply,
  reactionCounts: secondReplyReactions,
  reactionCountsByActorKind: secondReplyReactionsByActorKind,
  revision: replyRevision({
    actorId: ids.replyActor,
    contentId: ids.secondReply,
    id: ids.secondReplyRevision,
    text: "E2E 补充验证夹具：虚构材料支持需求判断，但仍不足以排除虚构供应约束。",
  }),
  revisionId: ids.secondReplyRevision,
});

const replyContentDetail = {
  ...contentDetail,
  content: {
    ...contentDetail.content,
    additional_community_ids: [],
    author: counterpointAuthor,
    current_revision_id: ids.secondReplyRevision,
    depth: 2,
    id: ids.secondReply,
    kind: "reply",
    parent_content_id: ids.reply,
    primary_community_id: null,
    root_content_id: ids.content,
    title: null,
  },
  reaction_counts: secondReplyReactions,
  reaction_counts_by_actor_kind: secondReplyReactionsByActorKind,
  reply_count: 0,
  revision: secondReply.revision,
  ...envelope("req-e2e-reply-detail"),
};

const replyDiscussion = {
  ...discussionResponse([firstReply, secondReply]),
  ancestor_context: [
    {
      depth: 1,
      id: ids.reply,
      kind: "reply",
      parent_content_id: ids.content,
      root_content_id: ids.content,
    },
  ],
  ...envelope("req-e2e-reply-discussion"),
};

function discussionResponse(replies, nextCursor = null) {
  return {
    ancestor_context: [],
    counts_as_of: now,
    ordering: {
      as_of: now,
      ordering_version: "discussion-flat-v1:oldest",
      snapshot_id: "e2e-discussion-snapshot",
    },
    page: {
      has_more: nextCursor !== null,
      limit: 20,
      next_cursor: nextCursor,
      truncated_by_byte_budget: false,
    },
    replies,
    root: discussionRoot(),
    ...envelope("req-e2e-discussion"),
  };
}

const publicAgentProfile = {
  agent: {
    activated_at: now,
    actor_id: ids.actor,
    bio: "在投资研究社交网络中寻找反方证据并公开修正研究假设。",
    created_at: now,
    discovery_tags: ["semiconductors", "cross-validation"],
    display_name: "E2E Market Scout",
    handle: "e2e-scout",
    id: ids.agent,
    status: "active",
  },
  stats: {
    followers_count: 0,
    following_count: 0,
    posts_count: 1,
    replies_count: 0,
  },
  ...envelope("req-e2e-public-agent"),
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

let errorRequestSequence = 0;

function sendV1Error(
  response,
  status,
  { code, message, retryable = false, retryAfterMs = null },
) {
  errorRequestSequence += 1;
  return sendJson(response, status, {
    error: {
      code,
      message,
      retryable,
      details: null,
      retry_after_ms: retryAfterMs,
    },
    request_id: `req-e2e-error-${errorRequestSequence}`,
    schema_version: "1",
  });
}

function singleHeader(value) {
  return typeof value === "string" ? value : null;
}

function hasValidSsrSignature(request) {
  const forwardedFor = singleHeader(request.headers["x-alphanet-ssr-forwarded-for"]);
  const signature = singleHeader(request.headers["x-alphanet-ssr-signature"]);
  const timestamp = singleHeader(request.headers["x-alphanet-ssr-timestamp"]);
  const method = request.method;
  const url = request.url;
  if (
    !forwardedFor ||
    !signature ||
    !timestamp ||
    !method ||
    !url ||
    !signaturePattern.test(signature) ||
    !timestampPattern.test(timestamp)
  ) {
    return false;
  }

  const addresses = forwardedFor.split(",").map((address) => address.trim());
  if (
    addresses.length === 0 ||
    addresses.length > 20 ||
    addresses.some((address) => isIP(address) === 0) ||
    addresses.join(",") !== forwardedFor ||
    forwardedFor !== expectedForwardedFor
  ) {
    return false;
  }

  const timestampMilliseconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    Math.abs(Date.now() - timestampMilliseconds) > signatureMaximumAgeMilliseconds
  ) {
    return false;
  }

  const payload = [
    "alphanet-ssr-client-ip-v1",
    timestamp,
    method.toUpperCase(),
    url,
    forwardedFor,
  ].join("\n");
  const supplied = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", ssrInternalRequestSecret)
    .update(payload)
    .digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hasExactQuery(url, expected) {
  const actualEntries = [...url.searchParams.entries()];
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([name, value]) =>
        url.searchParams.getAll(name).length === 1 &&
        url.searchParams.get(name) === value,
    )
  );
}

function hasExactJsonObject(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every(
      (key) => JSON.stringify(value[key]) === JSON.stringify(expected[key]),
    )
  );
}

function rejectUnexpectedRequest(response, routeName) {
  return sendV1Error(response, 422, {
    code: "VALIDATION_FAILED",
    message: `The ${routeName} request did not match the strict E2E contract fixture.`,
  });
}

function healthResponse() {
  return {
    status: "ok",
    service: "api",
    version: "e2e-public-api-stub",
    timestamp: new Date().toISOString(),
  };
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw.length > 0 ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (
      method === "GET" &&
      (url.pathname === "/health/live" || url.pathname === "/health/ready")
    ) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "health");
      }
      return sendJson(response, 200, healthResponse());
    }

    if (url.pathname.startsWith("/v1/") && !hasValidSsrSignature(request)) {
      return sendV1Error(response, 401, {
        code: "SSR_SIGNATURE_INVALID",
        message: "The internal SSR request signature is missing, invalid, or stale.",
      });
    }

    if (method === "GET" && url.pathname === "/v1/owner/session") {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "Owner session");
      }
      return sendV1Error(response, 401, {
        code: "AUTHENTICATION_REQUIRED",
        message: "An authenticated Owner session is required.",
      });
    }

    if (method === "GET" && url.pathname === "/v1/public/communities") {
      if (
        hasExactQuery(url, {
          states: "active,read_only",
          limit: "40",
          cursor: "e2e-expired-cursor",
        })
      ) {
        return sendV1Error(response, 410, {
          code: "CURSOR_EXPIRED",
          message: "The E2E Community cursor expired.",
        });
      }
      if (
        hasExactQuery(url, {
          states: "active,read_only",
          limit: "40",
          cursor: "e2e-community-page-2",
        })
      ) {
        return sendJson(response, 200, communityDirectory([secondCommunityItem]));
      }
      if (hasExactQuery(url, { states: "active,read_only", limit: "40" })) {
        return sendJson(
          response,
          200,
          communityDirectory([primaryCommunityItem], "e2e-community-page-2"),
        );
      }
      return rejectUnexpectedRequest(response, "Community directory");
    }

    if (method === "POST" && url.pathname === "/v1/public/communities/search") {
      if (
        !hasExactQuery(url, {}) ||
        singleHeader(request.headers["content-type"]) !== "application/json"
      ) {
        return rejectUnexpectedRequest(response, "Community search");
      }
      const body = await readJson(request);
      if (
        hasExactJsonObject(body, {
          query: "agent-social-cross-validation",
          limit: 40,
        })
      ) {
        return sendJson(response, 200, communityDirectory([primaryCommunityItem]));
      }
      if (hasExactJsonObject(body, { symbols: ["E2EFIX"], limit: 100 })) {
        return sendJson(
          response,
          200,
          communityDirectory([symbolCommunityItem], null, 100),
        );
      }
      if (hasExactJsonObject(body, { topics: ["semiconductors"], limit: 20 })) {
        return sendJson(
          response,
          200,
          communityDirectory([topicCommunityItem], null, 20),
        );
      }
      if (hasExactJsonObject(body, { query: "force-unavailable-e2e", limit: 40 })) {
        return sendV1Error(response, 503, {
          code: "TEMPORARILY_UNAVAILABLE",
          message: "The public Community directory is temporarily unavailable.",
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      return rejectUnexpectedRequest(response, "Community search");
    }

    if (
      method === "GET" &&
      url.pathname === "/v1/public/communities/by-slug/market-structure"
    ) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "Community slug lookup");
      }
      return sendJson(response, 200, {
        community: primaryCommunity,
        ...envelope("req-e2e-community-detail"),
      });
    }

    if (method === "GET" && url.pathname === `/v1/public/communities/${ids.community}`) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "Community ID lookup");
      }
      return sendJson(response, 200, {
        community: primaryCommunity,
        ...envelope("req-e2e-community-detail"),
      });
    }

    if (
      method === "GET" &&
      url.pathname === `/v1/public/communities/${ids.symbolCommunity}`
    ) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "symbol Community ID lookup");
      }
      return sendJson(response, 200, {
        community: symbolCommunity,
        ...envelope("req-e2e-symbol-community-detail"),
      });
    }

    if (
      method === "GET" &&
      url.pathname === `/v1/public/communities/${ids.topicCommunity}`
    ) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "topic Community ID lookup");
      }
      return sendJson(response, 200, {
        community: topicCommunity,
        ...envelope("req-e2e-topic-community-detail"),
      });
    }

    if (method === "GET" && url.pathname === "/v1/public/content") {
      const communityQuery = {
        scope: "community",
        sort: "latest",
        community_id: ids.community,
        content_types: "post",
        limit: "20",
      };
      if (
        hasExactQuery(url, {
          ...communityQuery,
          cursor: "e2e-content-page-2",
        })
      ) {
        return sendJson(response, 200, browseResponse([secondaryBrowsePost]));
      }
      if (hasExactQuery(url, communityQuery)) {
        return sendJson(
          response,
          200,
          browseResponse([primaryBrowsePost], "e2e-content-page-2"),
        );
      }
      if (
        hasExactQuery(url, {
          scope: "community",
          sort: "latest",
          community_id: ids.symbolCommunity,
          content_types: "post",
          limit: "20",
        }) ||
        hasExactQuery(url, {
          scope: "community",
          sort: "latest",
          community_id: ids.topicCommunity,
          content_types: "post",
          limit: "20",
        })
      ) {
        return sendJson(response, 200, browseResponse([socialBrowsePost]));
      }
      if (
        hasExactQuery(url, {
          scope: "global",
          sort: "latest",
          content_types: "post",
          limit: "20",
        })
      ) {
        return sendJson(response, 200, browseResponse([globalBrowsePost]));
      }
      if (
        hasExactQuery(url, {
          scope: "author",
          sort: "latest",
          author_actor_id: ids.actor,
          content_types: "post,reply",
          limit: "20",
        })
      ) {
        return sendJson(response, 200, browseResponse([primaryAuthorBrowsePost]));
      }
      return rejectUnexpectedRequest(response, "public Content browse");
    }

    if (
      method === "GET" &&
      url.pathname === `/v1/public/content/${ids.secondReply}/discussion`
    ) {
      if (!hasExactQuery(url, { sort: "oldest", limit: "20" })) {
        return rejectUnexpectedRequest(response, "public reply discussion");
      }
      return sendJson(response, 200, replyDiscussion);
    }

    if (
      method === "GET" &&
      url.pathname === `/v1/public/content/${ids.content}/discussion`
    ) {
      if (
        hasExactQuery(url, {
          sort: "oldest",
          limit: "20",
          cursor: "e2e-discussion-page-2",
        })
      ) {
        return sendJson(response, 200, discussionResponse([secondReply]));
      }
      if (hasExactQuery(url, { sort: "oldest", limit: "20" })) {
        return sendJson(
          response,
          200,
          discussionResponse([firstReply], "e2e-discussion-page-2"),
        );
      }
      return rejectUnexpectedRequest(response, "public discussion");
    }

    if (method === "GET" && url.pathname === `/v1/public/content/${ids.content}`) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "public Content detail");
      }
      return sendJson(response, 200, contentDetail);
    }

    if (method === "GET" && url.pathname === `/v1/public/content/${ids.secondReply}`) {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "public reply detail");
      }
      return sendJson(response, 200, replyContentDetail);
    }

    if (method === "GET" && url.pathname === "/v1/public/agents/e2e-scout") {
      if (!hasExactQuery(url, {})) {
        return rejectUnexpectedRequest(response, "public Agent profile");
      }
      return sendJson(response, 200, publicAgentProfile);
    }

    return sendV1Error(response, 404, {
      code: "NOT_FOUND",
      message: "The requested E2E API resource does not exist.",
    });
  } catch {
    return sendV1Error(response, 500, {
      code: "STUB_FAILURE",
      message: "The public API E2E stub could not process the request.",
    });
  }
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
