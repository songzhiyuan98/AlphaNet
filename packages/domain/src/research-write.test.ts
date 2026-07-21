import { createHmac, randomBytes } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import type { AgentCredentialContext, AgentPolicyTier } from "./agent-connection.js";
import {
  catalogSymbolCommunitySlug,
  COMMUNITY_RESEARCH_MIGRATION_CHECKSUM,
} from "./community-directory.js";
import {
  digestResearchCommand,
  digestResearchCommandBytes,
  freezeUpdateContentBaseline,
  normalizeCreatePostCommand,
  normalizeDeleteContentCommand,
  normalizeReplyCommand,
  normalizeUpdateContentCommand,
  type NormalizedResearchCommand,
} from "./research-command.js";
import {
  encryptPendingCommand,
  type PendingCommandKeyRing,
} from "./pending-command-codec.js";
import type {
  FencedPendingAction,
  PendingActionExecutionClaim,
} from "./pending-action-execution.js";
import {
  PostgresResearchWriteService,
  type ApprovedResearchExecutionError,
  type ApprovedResearchExecutionRepository,
  type CreatePostResearchWriteInput,
  type DeleteContentResearchWriteInput,
  type PostgresResearchWriteOptions,
  type UpdateContentResearchWriteInput,
} from "./research-write.js";
import {
  CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM,
  PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM,
} from "./schema-migrations.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const credentialId = "00000000-0000-4000-8000-000000000004";
const policyId = "00000000-0000-4000-8000-000000000005";
const communityId = "00000000-0000-4000-8000-000000000101";
const additionalCommunityId = "00000000-0000-4000-8000-000000000102";
const catalogCommunityId = "00000000-0000-4000-8000-000000000103";
const catalogSymbolId = "00000000-0000-4000-8000-000000000104";
const parentContentId = "00000000-0000-4000-8000-000000000201";
const rootContentId = "00000000-0000-4000-8000-000000000202";
const referenceContentId = "00000000-0000-4000-8000-000000000203";
const editableContentId = "00000000-0000-4000-8000-000000000204";
const currentRevisionId = "00000000-0000-4000-8000-000000000205";
const symbolId = "00000000-0000-4000-8000-000000000301";
const topicId = "00000000-0000-4000-8000-000000000302";
const mentionedActorId = "00000000-0000-4000-8000-000000000303";
const outboxEventId = "00000000-0000-4000-8000-000000000401";
const now = new Date("2026-07-20T12:00:00.000Z");

const defaultRules = {
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
};

function agentContext(tier: AgentPolicyTier): AgentCredentialContext {
  return {
    owner: { id: ownerId },
    agent: {
      id: agentId,
      actorId,
      ownerId,
      handle: "agent-alpha",
      displayName: "Agent Alpha",
      bio: null,
      discoveryTags: [],
      status: "active",
      restrictionReasonCode: null,
      credentialCount: 1,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      activatedAt: new Date("2026-07-01T00:00:00Z"),
      archivedAt: null,
      policy: {
        id: policyId,
        tier,
        defaultsVersion: "agent-permission-defaults-v1",
        rules: { operations: {} },
        schemaVersion: 1,
        version: "1",
        effectiveFrom: new Date("2026-07-01T00:00:00Z"),
      },
    },
    credential: {
      id: credentialId,
      ownerId,
      agentId,
      name: "Test credential",
      type: "static_api_key",
      prefix: "aln_v1_example",
      scopes: ["content:write"],
      audience: "alphanet-api",
      policyCeiling: "autonomous",
      policyCeilingDefaultsVersion: "agent-permission-defaults-v1",
      policyCeilingRules: { operations: {} },
      policyCeilingSchemaVersion: 1,
      issuedAt: new Date("2026-07-01T00:00:00Z"),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      replacesCredentialId: null,
      status: "active",
    },
  };
}

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface FakeTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  array(value: readonly unknown[]): readonly unknown[];
  json(value: unknown): unknown;
  savepoint<T>(
    name: string,
    callback: (transaction: FakeTransaction) => Promise<T>,
  ): Promise<T>;
}

interface FakeRootSql extends FakeTransaction {
  begin<T>(callback: (transaction: FakeTransaction) => Promise<T>): Promise<T>;
}

interface HarnessOptions {
  agentActivatedAt?: Date | null | undefined;
  agentPostCount?: number | undefined;
  agentPostCounts?: number[] | undefined;
  agentReplyCount?: number | undefined;
  agentReplyCounts?: number[] | undefined;
  allowedContent?: string[] | undefined;
  authTier?: AgentPolicyTier | undefined;
  catalogOnly?: boolean | undefined;
  communityRules?:
    | Record<
        string,
        {
          allowedContent?: string[] | undefined;
          maxPostsPerHour?: number | undefined;
          repliesOpen?: boolean | undefined;
          requiresSources?: boolean | undefined;
        }
      >
    | undefined;
  deleteTarget?:
    | false
    | {
        actorId?: string | undefined;
        currentRevisionId?: string | undefined;
        kind?: "post" | "reply" | undefined;
        lifecycleState?: "published" | "deleted" | undefined;
        rootId?: string | undefined;
        version?: number | undefined;
      }
    | undefined;
  existingIdempotency?:
    | {
        digest: Buffer;
        response: unknown;
        status:
          | "admission_reserved"
          | "in_progress"
          | "pending_approval"
          | "succeeded"
          | "denied"
          | "failed";
      }
    | undefined;
  maxPostsPerHour?: number | undefined;
  missingCommunityIds?: readonly string[] | undefined;
  outboxNextSequence?: string | undefined;
  ownerPostCount?: number | undefined;
  ownerPostCounts?: number[] | undefined;
  ownerWriteCount?: number | undefined;
  ownerWriteCounts?: number[] | undefined;
  duplicateContentId?: string | undefined;
  threadReplyCount?: number | undefined;
  pairReplyCount?: number | undefined;
  parentAuthorActorId?: string | undefined;
  activePendingCount?: number | undefined;
  protectedIntentCount?: number | undefined;
  rateCount?: number | undefined;
  rateCountByCommunity?: Record<string, number> | undefined;
  repliesOpen?: boolean | undefined;
  requiresSources?: boolean | undefined;
  updateTarget?:
    | false
    | {
        actorId?: string | undefined;
        bodyMarkdown?: string | undefined;
        kind?: "post" | "reply" | undefined;
        title?: string | null | undefined;
        version?: number | undefined;
      }
    | undefined;
  updateActorCount?: number | undefined;
  updateContentCount?: number | undefined;
}

interface HarnessTransaction {
  createdPendingAction: boolean;
  quotaCommunityIds: Set<string>;
  queries: CapturedQuery[];
  releases: (() => void)[];
  succeededContentActions: Set<string>;
}

class SqlHarness {
  readonly queries: CapturedQuery[] = [];
  readonly sql: PostgresClient;
  readonly transactionQueries: CapturedQuery[][] = [];
  transactionCount = 0;
  #activePendingCount = 0;
  readonly #admittedCounts = new Map<string, number>();
  readonly #agentSucceededCounts = new Map<string, number>();
  readonly #lockTails = new Map<string, Promise<void>>();
  #materialized = false;
  readonly #options: HarnessOptions;
  #protectedIntentCount = 0;

  get materialized(): boolean {
    return this.#materialized;
  }

  constructor(options: HarnessOptions = {}) {
    this.#options = options;
    const sql = this.#tag() as FakeRootSql;
    sql.begin = async <T>(callback: (tx: FakeTransaction) => Promise<T>) => {
      this.transactionCount += 1;
      const context: HarnessTransaction = {
        createdPendingAction: false,
        quotaCommunityIds: new Set(),
        queries: [],
        releases: [],
        succeededContentActions: new Set(),
      };
      this.transactionQueries.push(context.queries);
      try {
        const result = await callback(this.#tag(context));
        for (const communityId of context.quotaCommunityIds) {
          this.#admittedCounts.set(
            communityId,
            (this.#admittedCounts.get(communityId) ?? 0) + 1,
          );
        }
        if (context.createdPendingAction) {
          this.#activePendingCount += 1;
          this.#protectedIntentCount += 1;
        }
        for (const action of context.succeededContentActions) {
          this.#agentSucceededCounts.set(
            action,
            (this.#agentSucceededCounts.get(action) ?? 0) + 1,
          );
        }
        return result;
      } finally {
        for (const release of context.releases.reverse()) release();
      }
    };
    this.sql = sql as unknown as PostgresClient;
  }

  #tag(context?: HarnessTransaction): FakeTransaction {
    const tag = ((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown[]> => {
      const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
      const query = { text, values };
      this.queries.push(query);
      context?.queries.push(query);
      return this.#respond(text, values, context);
    }) as FakeTransaction;
    tag.array = (value: readonly unknown[]) => value;
    tag.json = (value: unknown) => value;
    tag.savepoint = async <T>(
      _name: string,
      callback: (transaction: FakeTransaction) => Promise<T>,
    ) => {
      const materializedBeforeSavepoint = this.#materialized;
      try {
        return await callback(this.#tag(context));
      } catch (error) {
        this.#materialized = materializedBeforeSavepoint;
        throw error;
      }
    };
    return tag;
  }

  async #respond(
    text: string,
    values: unknown[],
    context?: HarnessTransaction,
  ): Promise<unknown[]> {
    if (text.startsWith("set local")) return [];
    if (text === "select clock_timestamp() as database_now") {
      return [{ database_now: new Date(now.valueOf()) }];
    }
    if (text.includes("as ready") && text.includes("system.schema_migrations")) {
      return [{ ready: true }];
    }
    if (text.includes("select owner.id from platform.owners")) {
      return [{ id: ownerId }];
    }
    if (
      text.includes("from platform.credentials as credential") &&
      text.includes("policy.version::text as policy_version")
    ) {
      return [
        {
          actor_id: actorId,
          agent_activated_at:
            this.#options.agentActivatedAt === undefined
              ? new Date("2026-07-01T00:00:00.000Z")
              : this.#options.agentActivatedAt,
          credential_scopes: ["content:write"],
          credential_policy_ceiling: "autonomous",
          credential_policy_ceiling_defaults_version: "agent-permission-defaults-v1",
          credential_policy_ceiling_rules: {},
          credential_policy_ceiling_schema_version: 1,
          defaults_version: "agent-permission-defaults-v1",
          policy_id: policyId,
          policy_rules: {},
          policy_schema_version: 1,
          policy_tier: this.#options.authTier ?? "autonomous",
          policy_version: "1",
        },
      ];
    }
    if (text.includes("pg_catalog.pg_advisory_xact_lock")) {
      const lockKey = values.find((value): value is string => typeof value === "string");
      if (context && lockKey) {
        const previous = this.#lockTails.get(lockKey) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => held);
        this.#lockTails.set(lockKey, tail);
        await previous;
        context.releases.push(release);
        if (lockKey.includes("community-post-rate:")) {
          const communityId = lockKey.slice(lockKey.lastIndexOf(":") + 1);
          context.quotaCommunityIds.add(communityId);
        }
      }
      return [];
    }
    if (text.includes("select id, request_digest, status, response_body")) {
      const existing = this.#options.existingIdempotency;
      return existing
        ? [
            {
              id: "00000000-0000-4000-8000-000000000901",
              request_digest: existing.digest,
              response_body: existing.response,
              status: existing.status,
            },
          ]
        : [];
    }
    if (
      text.includes("revision.revision_number::integer as current_revision_number") &&
      text.includes("for update of content")
    ) {
      if (this.#options.updateTarget === false) return [];
      const target = this.#options.updateTarget ?? {};
      const queriedId = values[0];
      const kind = target.kind ?? "post";
      return [
        {
          author_actor_id: target.actorId ?? actorId,
          body_markdown:
            target.bodyMarkdown ?? "Base case revenue remains sensitive to product mix.",
          current_revision_id: currentRevisionId,
          current_revision_number: 2,
          depth: kind === "post" ? 0 : 1,
          distribution_state: "normal",
          kind,
          lifecycle_state: "published",
          parent_id: kind === "post" ? null : parentContentId,
          primary_community_id: kind === "post" ? communityId : null,
          root_id: kind === "post" ? queriedId : rootContentId,
          title:
            target.title === undefined
              ? kind === "post"
                ? "AMD data-center scenario review"
                : null
              : target.title,
          version: target.version ?? 2,
        },
      ];
    }
    if (
      text.includes("content.current_revision_id") &&
      text.includes("content.lifecycle_state") &&
      text.includes("for update") &&
      !text.includes("current_revision_number")
    ) {
      if (this.#options.deleteTarget === false) return [];
      const target = this.#options.deleteTarget ?? {};
      const queriedId = values[0];
      const kind = target.kind ?? "post";
      return [
        {
          author_actor_id: target.actorId ?? actorId,
          current_revision_id: target.currentRevisionId ?? currentRevisionId,
          distribution_state: "normal",
          kind,
          lifecycle_state: target.lifecycleState ?? "published",
          root_id: target.rootId ?? (kind === "post" ? queriedId : rootContentId),
          version: target.version ?? 2,
        },
      ];
    }
    if (
      text.includes("from platform.content_symbols as content_symbol") &&
      text.includes("order by content_symbol.position")
    ) {
      return [];
    }
    if (
      text.includes("from platform.content_topics as content_topic") &&
      text.includes("order by content_topic.position")
    ) {
      return [];
    }
    if (
      text.includes("from platform.source_links as source") &&
      text.includes("source.removed_revision_id is null")
    ) {
      return [];
    }
    if (
      text.includes("from platform.content_relations as relation") &&
      text.includes("relation.removed_revision_id is null")
    ) {
      return [];
    }
    if (
      text.includes("from platform.mentions as mention") &&
      text.includes("mention.revision_id")
    ) {
      return [];
    }
    if (
      text.includes("from platform.action_logs as log") &&
      text.includes("content.update_content") &&
      text.includes("as actor_count")
    ) {
      return [
        {
          actor_count: this.#options.updateActorCount ?? 0,
          actor_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
          content_count: this.#options.updateContentCount ?? 0,
          content_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
        },
      ];
    }
    if (
      text.startsWith("update platform.content_items") &&
      text.includes("returning id")
    ) {
      return [{ id: editableContentId }];
    }
    if (
      text.startsWith("update platform.content_items") &&
      text.includes("lifecycle_state = 'deleted'") &&
      text.includes("returning version")
    ) {
      const version = values.find((value): value is number => typeof value === "number");
      return version === undefined ? [] : [{ version }];
    }
    if (text.includes("from platform.communities as community")) {
      const queriedId = values[0];
      if (
        typeof queriedId === "string" &&
        this.#options.missingCommunityIds?.includes(queriedId)
      ) {
        return [];
      }
      if (
        this.#options.catalogOnly &&
        queriedId === catalogCommunityId &&
        !this.#materialized
      ) {
        return [];
      }
      const communityRule =
        typeof queriedId === "string"
          ? this.#options.communityRules?.[queriedId]
          : undefined;
      return [
        {
          id: queriedId,
          kind: this.#options.catalogOnly ? "symbol" : "general",
          state: "active",
          posting_rules: {
            ...defaultRules,
            allowed_content:
              communityRule?.allowedContent ??
              this.#options.allowedContent ??
              defaultRules.allowed_content,
            max_posts_per_hour:
              communityRule?.maxPostsPerHour ??
              this.#options.maxPostsPerHour ??
              defaultRules.max_posts_per_hour,
            replies_open: communityRule?.repliesOpen ?? this.#options.repliesOpen ?? true,
            requires_sources:
              communityRule?.requiresSources ?? this.#options.requiresSources ?? false,
          },
          canonical_symbol_id: this.#options.catalogOnly ? catalogSymbolId : null,
        },
      ];
    }
    if (
      text.includes("from platform.symbols as symbol") &&
      text.includes("symbol.community_candidate_id") &&
      text.includes("limit 1")
    ) {
      const queriedId = values[0];
      if (
        typeof queriedId === "string" &&
        this.#options.missingCommunityIds?.includes(queriedId)
      ) {
        return [];
      }
      return [
        {
          id: catalogSymbolId,
          community_candidate_id: catalogCommunityId,
          ticker: "AMD",
          exchange: "NASDAQ",
          name: "Advanced Micro Devices, Inc.",
        },
      ];
    }
    if (text.startsWith("insert into platform.communities")) {
      this.#materialized = true;
      return [];
    }
    if (
      text.includes("hourly_intent_count") &&
      text.includes("from platform.pending_actions")
    ) {
      return [
        {
          active_pending_count:
            (this.#options.activePendingCount ?? 0) + this.#activePendingCount,
          active_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
          hourly_intent_count:
            (this.#options.protectedIntentCount ?? 0) + this.#protectedIntentCount,
          hourly_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
        },
      ];
    }
    if (text.includes("with admitted as")) {
      const communityId = typeof values[1] === "string" ? values[1] : "";
      return [
        {
          admitted_count:
            (this.#options.rateCountByCommunity?.[communityId] ??
              this.#options.rateCount ??
              0) + (this.#admittedCounts.get(communityId) ?? 0),
          retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
        },
      ];
    }
    if (
      text.includes("as post_count") &&
      text.includes("as write_count") &&
      text.includes("from platform.action_logs as log")
    ) {
      const postCount =
        this.#options.ownerPostCounts?.shift() ?? this.#options.ownerPostCount ?? 0;
      const writeCount =
        this.#options.ownerWriteCounts?.shift() ?? this.#options.ownerWriteCount ?? 0;
      return [
        {
          post_count: postCount,
          post_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
          write_count: writeCount,
          write_retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
        },
      ];
    }
    if (
      text.includes("as succeeded_count") &&
      text.includes("from platform.action_logs as log")
    ) {
      const action = values.find(
        (value): value is string =>
          value === "content.create_post" ||
          value === "content.reply_to_content" ||
          value === "content.update_content" ||
          value === "content.delete_content",
      );
      if (!action) throw new Error("Agent content quota query omitted its action.");
      const sequence =
        action === "content.create_post"
          ? this.#options.agentPostCounts
          : this.#options.agentReplyCounts;
      const configured = sequence?.shift();
      const base =
        configured ??
        (action === "content.create_post"
          ? this.#options.agentPostCount
          : this.#options.agentReplyCount) ??
        0;
      return [
        {
          retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
          succeeded_count: base + (this.#agentSucceededCounts.get(action) ?? 0),
        },
      ];
    }
    if (text.includes("from platform.content_items as parent")) {
      return [
        {
          depth: 0,
          parent_author_actor_id: this.#options.parentAuthorActorId ?? mentionedActorId,
          parent_lifecycle_state: "published",
          parent_distribution_state: "normal",
          root_id: rootContentId,
          root_lifecycle_state: "published",
          root_distribution_state: "normal",
          primary_community_id: communityId,
        },
      ];
    }
    if (
      text.includes("from platform.content_revisions as revision") &&
      text.includes("original_content_id")
    ) {
      return this.#options.duplicateContentId
        ? [{ original_content_id: this.#options.duplicateContentId }]
        : [];
    }
    if (
      text.includes("as admitted_count") &&
      text.includes("from platform.content_items as reply") &&
      text.includes("join platform.content_items as parent")
    ) {
      return [
        {
          admitted_count: this.#options.pairReplyCount ?? 0,
          retry_at: new Date(now.valueOf() + 15 * 60 * 1_000),
        },
      ];
    }
    if (
      text.includes("as admitted_count") &&
      text.includes("from platform.content_items as reply")
    ) {
      return [
        {
          admitted_count: this.#options.threadReplyCount ?? 0,
          retry_at: new Date(now.valueOf() + 30 * 60 * 1_000),
        },
      ];
    }
    if (text.includes("from platform.content_additional_communities")) {
      return [
        {
          community_id: additionalCommunityId,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ];
    }
    if (
      text.includes("select symbol.id, symbol.ticker::text as value") &&
      text.includes("symbol.status = 'active'")
    ) {
      return [{ id: symbolId, value: "AMD" }];
    }
    if (text.includes("select topic.id, topic.slug::text as value")) {
      return [{ id: topicId, value: "semiconductors" }];
    }
    if (
      text.includes("from platform.content_items as content") &&
      text.includes("content.id = any")
    ) {
      return [{ id: referenceContentId }];
    }
    if (text.includes("lower(actor.handle::text) as handle")) {
      return [{ actor_id: mentionedActorId, handle: "market-scout" }];
    }
    if (
      text.includes("from system.outbox_aggregate_heads as head") &&
      text.includes("as next_sequence")
    ) {
      return [{ next_sequence: this.#options.outboxNextSequence ?? "1" }];
    }
    if (text.startsWith("insert into system.outbox_events")) {
      const aggregateSequence = values[2];
      if (typeof aggregateSequence !== "string") {
        throw new Error("Outbox aggregate sequence must be passed as a string");
      }
      return [{ id: outboxEventId, aggregate_sequence: aggregateSequence }];
    }
    if (text.startsWith("insert into platform.pending_actions")) {
      if (context) context.createdPendingAction = true;
      return [];
    }
    if (text.startsWith("insert into platform.action_logs")) {
      const afterState = values.find(
        (value): value is Record<string, unknown> =>
          isRecord(value) && "input_digest" in value && "idempotency_key_digest" in value,
      );
      if (
        !afterState ||
        typeof afterState.input_digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(afterState.input_digest) ||
        typeof afterState.idempotency_key_digest !== "string" ||
        !/^hmac-sha256:v[1-9][0-9]*:[0-9a-f]{64}$/u.test(
          afterState.idempotency_key_digest,
        )
      ) {
        throw new Error("Research domain-write audit is missing safe input digests");
      }
      const action = values.find(
        (value): value is string =>
          value === "content.create_post" ||
          value === "content.reply_to_content" ||
          value === "content.update_content",
      );
      if (
        action &&
        values.includes("succeeded") &&
        (typeof afterState.idempotency_record_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            afterState.idempotency_record_id,
          ))
      ) {
        throw new Error(
          "A successful research domain-write audit must link its idempotency record",
        );
      }
      if (context && action && values.includes("succeeded")) {
        context.succeededContentActions.add(action);
      }
      return [];
    }
    if (text.startsWith("delete from platform.idempotency_records")) {
      return [{ id: values[0] }];
    }
    if (
      text.startsWith("insert into") ||
      text.startsWith("update platform") ||
      text.startsWith("delete from platform")
    ) {
      return [];
    }
    throw new Error(`Unexpected SQL in test harness: ${text}`);
  }
}

function idFactory(): () => string {
  let counter = 1_000;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
}

function service(
  harness: SqlHarness,
  options: Pick<
    PostgresResearchWriteOptions,
    | "activePendingActionsPerAgent"
    | "agentContentRateLimits"
    | "antiSpamLimits"
    | "protectedActionIntentsPerHour"
  > & { pendingActionKeyRing?: PendingCommandKeyRing | undefined } = {},
): PostgresResearchWriteService {
  const { pendingActionKeyRing, ...serviceOptions } = options;
  return new PostgresResearchWriteService(harness.sql, {
    clock: () => new Date(now.valueOf()),
    idFactory: idFactory(),
    pendingActionKeyRing: pendingActionKeyRing ?? {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
    ...serviceOptions,
  });
}

function approvedExecutionFixture(
  keyRing: PendingCommandKeyRing,
  command: NormalizedResearchCommand = normalizeCreatePostCommand(postInput()),
): {
  claim: PendingActionExecutionClaim;
  frozenAction: FencedPendingAction;
  command: NormalizedResearchCommand;
} {
  const actionId = "00000000-0000-4000-8000-000000000801";
  const inputDigest = digestResearchCommand(command);
  const encrypted = encryptPendingCommand(
    command,
    {
      actionId,
      agentId,
      credentialId,
      inputDigest,
      operation: command.operation,
      ownerId,
    },
    keyRing,
  );
  return {
    claim: {
      actionId,
      attemptCount: 1,
      leaseExpiresAt: new Date(now.valueOf() + 60_000),
      leaseOwner: "worker-test",
      leaseToken: randomBytes(32),
      operation: command.operation,
      version: "3",
    },
    command,
    frozenAction: {
      actionId,
      agentId,
      attemptCount: 1,
      credentialId,
      decisionAuditId: "00000000-0000-4000-8000-000000000803",
      decisionId: "00000000-0000-4000-8000-000000000802",
      expectedVersion:
        command.operation === "update_content" || command.operation === "delete_content"
          ? command.expectedVersion
          : null,
      expiresAt: new Date(now.valueOf() + 60 * 60 * 1_000),
      failureCount: 0,
      idempotencyKey: "approved-research-idempotency-key",
      idempotencyRecordId: "00000000-0000-4000-8000-000000000804",
      inputDigest: digestResearchCommandBytes(command),
      normalizedInput: encrypted,
      operation: command.operation,
      ownerId,
      policyId,
      policySnapshot: {
        decision: "require_approval",
        decision_id: "00000000-0000-4000-8000-000000000802",
        policy_id: policyId,
        policy_version: "1",
      },
      policyVersion: "1",
      targetId:
        command.operation === "create_post"
          ? command.primaryCommunityId
          : command.operation === "reply_to_content"
            ? command.parentContentId
            : command.contentId,
      targetType: command.operation === "create_post" ? "community" : "content",
      version: "3",
    },
  };
}

function approvedExecutionRepository(
  harness: SqlHarness,
  frozenAction: FencedPendingAction,
): ApprovedResearchExecutionRepository & {
  finalizeSucceeded: ReturnType<typeof vi.fn>;
} {
  const finalizeSucceeded = vi.fn(
    (
      _transaction: unknown,
      claim: PendingActionExecutionClaim,
      input: Parameters<ApprovedResearchExecutionRepository["finalizeSucceeded"]>[2],
    ) =>
      Promise.resolve({
        action: {
          actionId: claim.actionId,
          attemptCount: claim.attemptCount,
          error: null,
          failureCount: 0,
          idempotencyResponse: {},
          idempotencyStatus: "succeeded" as const,
          operation: claim.operation,
          resourceId: input.resourceId,
          result: input.result,
          state: "succeeded" as const,
          terminalAt: new Date(now.valueOf()),
          version: "4",
        },
        resolvedOutboxEventId: "00000000-0000-4000-8000-000000000402",
      }),
  );
  return {
    finalizeSucceeded,
    withFencedClaim: async (_claim, callback) => {
      const result = await harness.sql.begin(async (transaction) => ({
        value: await callback(transaction, frozenAction),
      }));
      return result.value;
    },
  };
}

function postInput(
  overrides: Partial<CreatePostResearchWriteInput> = {},
): CreatePostResearchWriteInput {
  return {
    title: "AMD data-center scenario review",
    bodyMarkdown: "Base case revenue remains sensitive to product mix.",
    primaryCommunityId: communityId,
    idempotencyKey: "post-amd-v1",
    ...overrides,
  };
}

function updateInput(
  overrides: Partial<UpdateContentResearchWriteInput> = {},
): UpdateContentResearchWriteInput {
  return {
    contentId: editableContentId,
    expectedVersion: 2,
    patch: {
      bodyMarkdown: "Base case revenue now includes the FX sensitivity range.",
    },
    editSummary: "Add FX sensitivity",
    idempotencyKey: "update-amd-v3",
    ...overrides,
  };
}

function deleteInput(
  overrides: Partial<DeleteContentResearchWriteInput> = {},
): DeleteContentResearchWriteInput {
  return {
    contentId: editableContentId,
    expectedVersion: 2,
    idempotencyKey: "delete-amd-v2",
    mode: "soft",
    ...overrides,
  };
}

function persistedPendingAction(
  command: NormalizedResearchCommand,
  state:
    | "pending_approval"
    | "approved"
    | "executing"
    | "succeeded"
    | "rejected"
    | "expired"
    | "cancelled"
    | "failed"
    | "invalidated",
) {
  return {
    id: "00000000-0000-4000-8000-000000000821",
    operation: "create_post",
    state,
    expires_at: "2026-07-21T12:00:00.000Z",
    input_digest: digestResearchCommand(command),
    requested_at: now.toISOString(),
    decision_id: "00000000-0000-4000-8000-000000000822",
    policy_version: "1",
    approval_summary: "Create one post in 1 Community.",
  };
}

function hasSql(harness: SqlHarness, fragment: string): boolean {
  return harness.queries.some((query) => query.text.includes(fragment));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlIndex(harness: SqlHarness, fragment: string): number {
  return harness.queries.findIndex((query) => query.text.includes(fragment));
}

function researchAuditAfterState(harness: SqlHarness): Record<string, unknown> {
  const actionLog = harness.queries.find((query) =>
    query.text.startsWith("insert into platform.action_logs"),
  );
  const afterState = actionLog?.values.find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && "input_digest" in value && "idempotency_key_digest" in value,
  );
  if (!afterState) throw new Error("The research write has no ActionLog after_state.");
  return afterState;
}

describe("PostgresResearchWriteService", () => {
  it("pins readiness to migrations 000006/000007 and the critical write schema", async () => {
    const harness = new SqlHarness();
    await service(harness).checkReady();

    const readiness = harness.queries.find((query) =>
      query.text.includes("system.schema_migrations"),
    );
    expect(readiness?.values).toContain(COMMUNITY_RESEARCH_MIGRATION_CHECKSUM);
    expect(readiness?.values).toContain(PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM);
    expect(readiness?.values).toContain(CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM);
    expect(readiness?.text).toContain("platform.content_items");
    expect(readiness?.text).toContain("platform.pending_actions");
    expect(readiness?.text).toContain("content_revisions_prevent_mutation");
    expect(readiness?.text).toContain("content_revisions_validate_current_pointer");
  });

  it("validates the ActionLog HMAC key material at construction", () => {
    const harness = new SqlHarness();
    expect(
      () =>
        new PostgresResearchWriteService(harness.sql, {
          pendingActionKeyRing: {
            currentVersion: 1,
            keys: { 1: Buffer.alloc(31) },
          },
        }),
    ).toThrow("key-ring entry is invalid");
    expect(
      () =>
        new PostgresResearchWriteService(harness.sql, {
          pendingActionKeyRing: {
            currentVersion: 2,
            keys: { 1: Buffer.alloc(32) },
          },
        }),
    ).toThrow("current key material is unavailable");
  });

  it("validates Agent content-rate overrides without weakening safe defaults", () => {
    const harness = new SqlHarness();
    const pendingActionKeyRing = {
      currentVersion: 1,
      keys: { 1: Buffer.alloc(32) },
    } as const;
    expect(
      () =>
        new PostgresResearchWriteService(harness.sql, {
          agentContentRateLimits: {
            establishedPostsPerHour: 6,
            establishedRepliesPerHour: 30,
            newAgentPostsPerHour: 7,
            newAgentRepliesPerHour: 10,
          },
          pendingActionKeyRing,
        }),
    ).toThrow("new-Agent limits no greater than established-Agent limits");
    expect(
      () =>
        new PostgresResearchWriteService(harness.sql, {
          agentContentRateLimits: {
            establishedPostsPerHour: 10_001,
            establishedRepliesPerHour: 30,
            newAgentPostsPerHour: 2,
            newAgentRepliesPerHour: 10,
          },
          pendingActionKeyRing,
        }),
    ).toThrow("integers from one through ten thousand");
  });

  it("writes stable domain-separated audit digests without raw keys or research prose", async () => {
    const keyMaterial = Buffer.alloc(32, 19);
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: keyMaterial },
    };
    const rawIdempotencyKey = "same-key-same-key";
    const firstBody = "Private research prose marker 8fd4 must not enter ActionLog.";
    const secondBody = "A distinct normalized research body changes only input_digest.";
    const firstHarness = new SqlHarness();
    const secondHarness = new SqlHarness();

    await service(firstHarness, { pendingActionKeyRing: keyRing }).createPost(
      agentContext("autonomous"),
      postInput({ bodyMarkdown: firstBody, idempotencyKey: rawIdempotencyKey }),
      { requestId: "req-audit-digest-first" },
    );
    await service(secondHarness, { pendingActionKeyRing: keyRing }).createPost(
      agentContext("autonomous"),
      postInput({ bodyMarkdown: secondBody, idempotencyKey: rawIdempotencyKey }),
      { requestId: "req-audit-digest-second" },
    );

    const firstAfter = researchAuditAfterState(firstHarness);
    const secondAfter = researchAuditAfterState(secondHarness);
    expect(firstAfter.input_digest).toBe(
      digestResearchCommand(
        normalizeCreatePostCommand(
          postInput({ bodyMarkdown: firstBody, idempotencyKey: rawIdempotencyKey }),
        ),
      ),
    );
    expect(firstAfter.input_digest).not.toBe(secondAfter.input_digest);
    expect(firstAfter.idempotency_key_digest).toBe(secondAfter.idempotency_key_digest);
    expect(firstAfter.idempotency_key_digest).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/u);
    const undomainedDigest = `hmac-sha256:v1:${createHmac("sha256", keyMaterial)
      .update(rawIdempotencyKey, "utf8")
      .digest("hex")}`;
    expect(firstAfter.idempotency_key_digest).not.toBe(undomainedDigest);
    expect(firstAfter.idempotency_record_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const firstAuditValues = firstHarness.queries.find((query) =>
      query.text.startsWith("insert into platform.action_logs"),
    )?.values;
    const serializedAudit = JSON.stringify(firstAuditValues);
    expect(serializedAudit).not.toContain(rawIdempotencyKey);
    expect(serializedAudit).not.toContain(firstBody);
  });

  it("fails closed when the direct authorization row has no activation timestamp", async () => {
    const harness = new SqlHarness({ agentActivatedAt: null });

    await expect(
      service(harness).createPost(agentContext("autonomous"), postInput(), {
        requestId: "req-missing-agent-activation",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_CONTEXT_STALE" });
    const authorizationQuery = harness.queries.find((query) =>
      query.text.includes("from platform.credentials as credential"),
    );
    expect(authorizationQuery?.text).toContain(
      "agent.activated_at as agent_activated_at",
    );
    expect(authorizationQuery?.text).toContain("agent.activated_at is not null");
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
  });

  it("fails closed when the approved authorization row has no activation timestamp", async () => {
    const harness = new SqlHarness({ agentActivatedAt: null, authTier: "assisted" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(keyRing);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    } satisfies Partial<ApprovedResearchExecutionError>);
    const authorizationQuery = harness.queries.find((query) =>
      query.text.includes("from platform.credentials as credential"),
    );
    expect(authorizationQuery?.text).toContain(
      "agent.activated_at as agent_activated_at",
    );
    expect(authorizationQuery?.text).toContain("agent.activated_at is not null");
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
  });

  it("publishes an Owner-approved frozen post and finalizes the same fenced transaction", async () => {
    // The live policy may change after the Owner decision. The original
    // approval remains the write authorization while the current policy is
    // recorded independently as a fresh safety revalidation.
    const harness = new SqlHarness({ authTier: "autonomous" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(keyRing);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      clock: () => new Date(now.valueOf()),
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    const result = await writer.executeApprovedAction(repository, fixture.claim);

    expect(result.action.state).toBe("succeeded");
    expect(result.content).toMatchObject({
      resourceVersion: 1,
    });
    expect(hasSql(harness, "insert into platform.content_items")).toBe(true);
    expect(repository.finalizeSucceeded).toHaveBeenCalledOnce();
    expect(repository.finalizeSucceeded.mock.calls[0]?.[1]).toBe(fixture.claim);
    expect(repository.finalizeSucceeded.mock.calls[0]?.[2]).toMatchObject({
      correlatedOutboxEventId: outboxEventId,
      resourceId: result.content.contentId,
      result: {
        content_id: result.content.contentId,
        resource_version: 1,
      },
    });
    const approvedWriteAudit = harness.queries.find(
      (query) =>
        query.text.includes("insert into platform.action_logs") &&
        query.values.includes("owner_approval_record"),
    );
    expect(approvedWriteAudit?.values).toContain("owner_approval");
    expect(approvedWriteAudit?.values).toContain(ownerId);
    const authorizationSnapshot = approvedWriteAudit?.values.find(
      (value) => isRecord(value) && "live_revalidation" in value,
    );
    if (!isRecord(authorizationSnapshot)) {
      throw new Error("The approved write audit has no authorization snapshot.");
    }
    expect(authorizationSnapshot.decision).toBe("require_approval");
    expect(authorizationSnapshot.decision_id).toBe(fixture.frozenAction.decisionId);
    const liveRevalidation = authorizationSnapshot.live_revalidation;
    if (!isRecord(liveRevalidation)) {
      throw new Error("The approved write audit has no live revalidation.");
    }
    expect(liveRevalidation.decision).toBe("allow");
    expect(liveRevalidation.policy_id).toBe(policyId);
    expect(authorizationSnapshot.owner_approval).toEqual({
      decision_audit_id: fixture.frozenAction.decisionAuditId,
      method: "owner_approval",
    });
    expect(
      harness.queries.find((query) =>
        query.text.includes("from platform.credentials as credential"),
      )?.text,
    ).toContain("for share of credential, agent, actor, owner, policy");
  });

  it("keeps the pending and approved-worker key digest stable across key rotation", async () => {
    const firstKey = Buffer.alloc(32, 31);
    const creationKeyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: firstKey },
    };
    const executionKeyRing: PendingCommandKeyRing = {
      currentVersion: 2,
      keys: { 1: firstKey, 2: Buffer.alloc(32, 32) },
    };
    const fixture = approvedExecutionFixture(creationKeyRing);
    const pendingHarness = new SqlHarness({ authTier: "assisted" });
    await service(pendingHarness, {
      pendingActionKeyRing: creationKeyRing,
    }).createPost(
      agentContext("assisted"),
      postInput({ idempotencyKey: fixture.frozenAction.idempotencyKey }),
      { requestId: "req-audit-pending-before-rotation" },
    );

    const executionHarness = new SqlHarness({ authTier: "autonomous" });
    const repository = approvedExecutionRepository(
      executionHarness,
      fixture.frozenAction,
    );
    const writer = new PostgresResearchWriteService(executionHarness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: executionKeyRing,
    });
    await writer.executeApprovedAction(repository, fixture.claim);

    const pendingAfter = researchAuditAfterState(pendingHarness);
    const approvedAfter = researchAuditAfterState(executionHarness);
    expect(approvedAfter.input_digest).toBe(pendingAfter.input_digest);
    expect(approvedAfter.idempotency_key_digest).toBe(
      pendingAfter.idempotency_key_digest,
    );
    expect(approvedAfter.idempotency_key_digest).toMatch(/^hmac-sha256:v1:/u);
    expect(approvedAfter.idempotency_record_id).toBe(
      fixture.frozenAction.idempotencyRecordId,
    );
  });

  it("invalidates an approved action when current authority no longer permits writes", async () => {
    const harness = new SqlHarness({ authTier: "read_only" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(keyRing);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    } satisfies Partial<ApprovedResearchExecutionError>);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
  });

  it.each(["post", "reply"] as const)(
    "invalidates a legacy approved %s whose frozen Markdown exceeds the mention bound",
    async (kind) => {
      const harness = new SqlHarness({ authTier: "assisted" });
      const keyRing: PendingCommandKeyRing = {
        currentVersion: 1,
        keys: { 1: randomBytes(32) },
      };
      const bodyMarkdown = Array.from(
        { length: 101 },
        (_, index) => `@legacy-${index.toString(36).padStart(2, "0")}`,
      ).join(" ");
      const command =
        kind === "post"
          ? normalizeCreatePostCommand(postInput({ bodyMarkdown }))
          : normalizeReplyCommand({ bodyMarkdown, parentContentId });
      const fixture = approvedExecutionFixture(keyRing, command);
      const repository = approvedExecutionRepository(harness, fixture.frozenAction);
      const writer = new PostgresResearchWriteService(harness.sql, {
        idFactory: idFactory(),
        pendingActionKeyRing: keyRing,
      });

      await expect(
        writer.executeApprovedAction(repository, fixture.claim),
      ).rejects.toMatchObject({
        code: "APPROVED_ACTION_CONTEXT_INVALID",
        disposition: "invalidate",
      } satisfies Partial<ApprovedResearchExecutionError>);
      expect(hasSql(harness, "lower(actor.handle::text) as handle")).toBe(false);
      expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
      expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
    },
  );

  it("publishes an Owner-approved reply with its frozen discussion identity", async () => {
    const harness = new SqlHarness({ authTier: "assisted" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(
      keyRing,
      normalizeReplyCommand({
        bodyMarkdown: "A frozen reply with a substantive counterpoint.",
        parentContentId,
      }),
    );
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    const result = await writer.executeApprovedAction(repository, fixture.claim);

    expect(result.content).toMatchObject({
      resourceVersion: 1,
      rootContentId,
    });
    if (!("revisionId" in result.content)) {
      throw new Error("Expected an approved reply result.");
    }
    expect(repository.finalizeSucceeded).toHaveBeenCalledOnce();
    expect(repository.finalizeSucceeded.mock.calls[0]?.[2]).toMatchObject({
      resourceId: result.content.contentId,
      result: {
        content_id: result.content.contentId,
        resource_version: 1,
        revision_id: result.content.revisionId,
        root_content_id: rootContentId,
      },
    });
    expect(
      harness.queries.find((query) =>
        query.text.includes("from platform.content_items as parent"),
      ),
    ).toBeDefined();
  });

  it("executes an Owner-approved update only against its frozen current baseline", async () => {
    const harness = new SqlHarness({ authTier: "assisted" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const command = freezeUpdateContentBaseline(
      normalizeUpdateContentCommand(updateInput()),
      {
        additionalCommunityIds: [additionalCommunityId],
        bodyMarkdown: "Base case revenue remains sensitive to product mix.",
        contentKind: "post",
        primaryCommunityId: communityId,
        resourceVersion: 2,
        revisionId: currentRevisionId,
        title: "AMD data-center scenario review",
      },
    );
    const fixture = approvedExecutionFixture(keyRing, command);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    const result = await writer.executeApprovedAction(repository, fixture.claim);

    expect(result.content).toMatchObject({ resourceVersion: 3 });
    expect(hasSql(harness, "update platform.content_items")).toBe(true);
    expect(repository.finalizeSucceeded).toHaveBeenCalledOnce();
  });

  it("soft-deletes an Owner-approved authored item without replacing its Revision", async () => {
    const sensitiveReason = "Private portfolio reason must remain encrypted.";
    const harness = new SqlHarness({ authTier: "assisted" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const command = normalizeDeleteContentCommand(
      deleteInput({ reason: sensitiveReason }),
    );
    const fixture = approvedExecutionFixture(keyRing, command);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      clock: () => new Date(now.valueOf()),
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    const result = await writer.executeApprovedAction(repository, fixture.claim);

    expect(result.content).toEqual({
      contentId: editableContentId,
      lifecycleState: "deleted",
      resourceVersion: 3,
    });
    expect(hasSql(harness, "lifecycle_state = 'deleted'")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(false);
    const deletion = harness.queries.find(
      (query) =>
        query.text.startsWith("update platform.content_items") &&
        query.text.includes("lifecycle_state = 'deleted'"),
    );
    expect(deletion?.text).toContain("current_revision_id");
    expect(deletion?.values).toContain(currentRevisionId);
    const outbox = harness.queries.find((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
    expect(outbox?.values.slice(0, 6)).toEqual([
      "content",
      editableContentId,
      "1",
      "content.deleted",
      1,
      {
        actor_id: actorId,
        content_id: editableContentId,
        current_revision_id: currentRevisionId,
        kind: "post",
        lifecycle_state: "deleted",
        resource_version: 3,
        root_content_id: editableContentId,
      },
    ]);
    expect(repository.finalizeSucceeded).toHaveBeenCalledOnce();
    expect(repository.finalizeSucceeded.mock.calls[0]?.[2]).toMatchObject({
      correlatedOutboxEventId: outboxEventId,
      resourceId: editableContentId,
      result: {
        content_id: editableContentId,
        lifecycle_state: "deleted",
        resource_version: 3,
      },
    });
    expect(JSON.stringify(harness.queries)).not.toContain(sensitiveReason);
  });

  it("rechecks duplicate-content admission when an approved post reaches the worker", async () => {
    const harness = new SqlHarness({
      authTier: "assisted",
      duplicateContentId: referenceContentId,
    });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(keyRing);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      clock: () => new Date(now.valueOf()),
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    } satisfies Partial<ApprovedResearchExecutionError>);
    expect(hasSql(harness, "original_content_id")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
  });

  it("invalidates an Owner-approved update whose frozen baseline differs from the locked content", async () => {
    const harness = new SqlHarness({ authTier: "assisted" });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const command = freezeUpdateContentBaseline(
      normalizeUpdateContentCommand(updateInput()),
      {
        additionalCommunityIds: [additionalCommunityId],
        bodyMarkdown: "A stale frozen body that is no longer current.",
        contentKind: "post",
        primaryCommunityId: communityId,
        resourceVersion: 2,
        revisionId: currentRevisionId,
        title: "AMD data-center scenario review",
      },
    );
    const fixture = approvedExecutionFixture(keyRing, command);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_CONTEXT_INVALID",
      disposition: "invalidate",
    } satisfies Partial<ApprovedResearchExecutionError>);
    expect(hasSql(harness, "update platform.content_items")).toBe(false);
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
  });

  it("returns a sanitized retry disposition when approved execution hits a live rate gate", async () => {
    const harness = new SqlHarness({
      agentPostCount: 6,
      authTier: "assisted",
    });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(keyRing);
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_RATE_LIMITED",
      disposition: "retry",
      retryAfterMs: 30 * 60 * 1_000,
    } satisfies Partial<ApprovedResearchExecutionError>);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
    const denialAudit = harness.queries.find(
      (query) =>
        query.text.includes("insert into platform.action_logs") &&
        query.values.includes("RATE_LIMITED"),
    );
    expect(denialAudit?.values).toContain("owner_approval_record");
    expect(denialAudit?.values).toContain("denied");
    expect(
      denialAudit?.values.find(
        (value) => isRecord(value) && "pending_action_id" in value,
      ),
    ).toMatchObject({ pending_action_id: fixture.frozenAction.actionId });
    expect(hasSql(harness, "update platform.idempotency_records")).toBe(false);
  });

  it("rechecks the new-Agent reply quota in the approved worker without terminalizing the action", async () => {
    const harness = new SqlHarness({
      agentActivatedAt: new Date(now.valueOf() - 23 * 60 * 60 * 1_000),
      agentReplyCount: 10,
      authTier: "assisted",
    });
    const keyRing: PendingCommandKeyRing = {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    };
    const fixture = approvedExecutionFixture(
      keyRing,
      normalizeReplyCommand({
        bodyMarkdown: "A substantive counterpoint with a second source path.",
        parentContentId,
      }),
    );
    const repository = approvedExecutionRepository(harness, fixture.frozenAction);
    const writer = new PostgresResearchWriteService(harness.sql, {
      idFactory: idFactory(),
      pendingActionKeyRing: keyRing,
    });

    await expect(
      writer.executeApprovedAction(repository, fixture.claim),
    ).rejects.toMatchObject({
      code: "APPROVED_ACTION_RATE_LIMITED",
      disposition: "retry",
      retryAfterMs: 30 * 60 * 1_000,
    } satisfies Partial<ApprovedResearchExecutionError>);
    expect(repository.finalizeSucceeded).not.toHaveBeenCalled();
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    const quotaQuery = harness.queries.find((query) =>
      query.text.includes("as succeeded_count"),
    );
    expect(quotaQuery?.values).toContain("content.reply_to_content");
    const audit = harness.queries.find(
      (query) =>
        query.text.includes("insert into platform.action_logs") &&
        query.values.includes("RATE_LIMITED"),
    );
    expect(audit?.values).toContain("denied");
  });

  it("freezes an Assisted post as ciphertext without creating content", async () => {
    const harness = new SqlHarness({
      authTier: "assisted",
      outboxNextSequence: "41",
    });
    const result = await service(harness).createPost(
      agentContext("assisted"),
      postInput({ bodyMarkdown: "Private draft marker 9a7f." }),
      { requestId: "req-assisted" },
    );

    expect(result).toMatchObject({
      decision: "require_approval",
      operation: "create_post",
      replayed: false,
      result: null,
      status: "pending_approval",
    });
    expect(result.pendingAction).toMatchObject({
      operation: "create_post",
      state: "pending_approval",
    });
    const pendingReplayUpdate = harness.queries.find(
      (query) =>
        query.text.includes("update platform.idempotency_records") &&
        query.text.includes("pending_action_id"),
    );
    expect(pendingReplayUpdate?.text).toContain("resource_id = null");
    expect(pendingReplayUpdate?.values).toContain(result.pendingAction?.id);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(true);
    const outboxLock = harness.queries.find((query) =>
      query.text.includes("'alphanet:outbox-aggregate:'"),
    );
    expect(outboxLock?.text).toContain("pg_catalog.octet_length");
    expect(outboxLock?.values).toEqual([
      "pending_action",
      "pending_action",
      result.pendingAction?.id,
    ]);
    const sequenceAllocation = sqlIndex(
      harness,
      "from system.outbox_aggregate_heads as head",
    );
    const outboxInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
    expect(sequenceAllocation).toBeLessThan(
      sqlIndex(harness, "insert into system.outbox_events"),
    );
    expect(outboxInsert?.values.slice(0, 6)).toEqual([
      "pending_action",
      result.pendingAction?.id,
      "41",
      "action.pending_approval",
      1,
      {
        action_id: result.pendingAction?.id,
        actor_id: actorId,
        agent_id: agentId,
        operation: "create_post",
        owner_id: ownerId,
        target_id: communityId,
        target_type: "community",
      },
    ]);
    expect(outboxInsert?.values.slice(6)).toEqual([now, now, 12, now]);
    const auditInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into platform.action_logs"),
    );
    expect(auditInsert?.values).toContain(outboxEventId);
    const pendingInsert = harness.queries.find((query) =>
      query.text.includes("insert into platform.pending_actions"),
    );
    expect(
      pendingInsert?.values.some((value) => value === "Private draft marker 9a7f."),
    ).toBe(false);
  });

  it("commits an Autonomous post, Revision, facts, Outbox, audit, and idempotency atomically", async () => {
    const harness = new SqlHarness({ outboxNextSequence: "9007199254740993" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({
        bodyMarkdown: "@market-scout cites the original filing.",
        symbols: ["AMD"],
        topics: ["semiconductors"],
        sourceLinks: [{ url: "https://example.test/filing#risk" }],
        references: [{ targetContentId: referenceContentId, relationType: "reference" }],
      }),
      { channel: "mcp", requestId: "req-autonomous" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      pendingAction: null,
      replayed: false,
      status: "succeeded",
      result: { resourceVersion: 1 },
    });
    expect(harness.transactionCount).toBe(1);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_symbols")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_topics")).toBe(true);
    expect(hasSql(harness, "insert into platform.source_links")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_relations")).toBe(true);
    expect(hasSql(harness, "insert into platform.mentions")).toBe(true);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(true);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const outboxLock = harness.queries.find((query) =>
      query.text.includes("'alphanet:outbox-aggregate:'"),
    );
    expect(outboxLock?.values).toEqual(["content", "content", result.result?.contentId]);
    const outboxInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
    expect(outboxInsert?.values[2]).toBe("9007199254740993");
    expect(typeof outboxInsert?.values[2]).toBe("string");
    expect(outboxInsert?.values.slice(6)).toEqual([now, now, 12, now]);
    const auditInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into platform.action_logs"),
    );
    expect(auditInsert?.values).toContain(outboxEventId);

    const reserve = sqlIndex(harness, "insert into platform.idempotency_records");
    const content = sqlIndex(harness, "insert into platform.content_items");
    const outbox = sqlIndex(harness, "insert into system.outbox_events");
    const audit = sqlIndex(harness, "insert into platform.action_logs");
    const terminal = harness.queries.findLastIndex((query) =>
      query.text.includes("update platform.idempotency_records"),
    );
    expect(reserve).toBeLessThan(content);
    expect(content).toBeLessThan(outbox);
    expect(outbox).toBeLessThan(audit);
    expect(audit).toBeLessThan(terminal);
  });

  it("commits an authored update with OCC, one immutable Revision, and a minimal revised event", async () => {
    const harness = new SqlHarness();
    const marker = "Sensitive prose marker must stay out of operational records.";
    const result = await service(harness).updateContent(
      agentContext("autonomous"),
      updateInput({
        patch: {
          bodyMarkdown: marker,
          sourceLinks: [{ url: "https://example.test/new-source" }],
          topics: ["semiconductors"],
        },
      }),
      { requestId: "req-update-autonomous" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      operation: "update_content",
      status: "succeeded",
      result: {
        contentId: editableContentId,
        resourceVersion: 3,
      },
    });
    if (!result.result || !("revisionId" in result.result)) {
      throw new Error("Expected an autonomous update result.");
    }
    expect(result.result.revisionId).toMatch(/^00000000-0000-4000-8000-/u);
    expect(hasSql(harness, "for update of content")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(true);
    expect(hasSql(harness, "update platform.content_items")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_topics")).toBe(true);

    const outbox = harness.queries.find((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
    expect(outbox?.values).toContain("content.revised");
    expect(JSON.stringify(outbox?.values)).not.toContain(marker);
    const audit = harness.queries.find((query) =>
      query.text.startsWith("insert into platform.action_logs"),
    );
    expect(JSON.stringify(audit?.values)).not.toContain(marker);
    const idempotencyTerminal = harness.queries.findLast((query) =>
      query.text.startsWith("update platform.idempotency_records"),
    );
    expect(JSON.stringify(idempotencyTerminal?.values)).not.toContain(marker);
  });

  it("increments the resource version without creating an empty Revision for classification-only changes", async () => {
    const harness = new SqlHarness();
    const result = await service(harness).updateContent(
      agentContext("autonomous"),
      updateInput({
        patch: { symbols: ["AMD"] },
        editSummary: undefined,
        idempotencyKey: "update-amd-symbols-v3",
      }),
      { requestId: "req-update-classification" },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        contentId: editableContentId,
        resourceVersion: 3,
        revisionId: null,
      },
    });
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(false);
    expect(hasSql(harness, "insert into platform.content_symbols")).toBe(true);
  });

  it("soft-deletes authored content with OCC, a tombstone event, and a replayable terminal result", async () => {
    const harness = new SqlHarness({ outboxNextSequence: "17" });
    const result = await service(harness).deleteContent(
      agentContext("autonomous"),
      deleteInput(),
      { requestId: "req-delete-autonomous" },
    );

    expect(result).toEqual({
      decision: "allow",
      error: null,
      operation: "delete_content",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: editableContentId,
        lifecycleState: "deleted",
        resourceVersion: 3,
      },
      status: "succeeded",
    });
    const deletion = harness.queries.find(
      (query) =>
        query.text.startsWith("update platform.content_items") &&
        query.text.includes("lifecycle_state = 'deleted'"),
    );
    expect(deletion?.text).toContain("version =");
    expect(deletion?.text).toContain("current_revision_id");
    expect(deletion?.values).toEqual(
      expect.arrayContaining([3, editableContentId, actorId, 2, currentRevisionId]),
    );
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(false);

    const outbox = harness.queries.find((query) =>
      query.text.startsWith("insert into system.outbox_events"),
    );
    expect(outbox?.values.slice(0, 6)).toEqual([
      "content",
      editableContentId,
      "17",
      "content.deleted",
      1,
      {
        actor_id: actorId,
        content_id: editableContentId,
        current_revision_id: currentRevisionId,
        kind: "post",
        lifecycle_state: "deleted",
        resource_version: 3,
        root_content_id: editableContentId,
      },
    ]);
    expect(researchAuditAfterState(harness)).toMatchObject({
      content_id: editableContentId,
      lifecycle_state: "deleted",
      resource_version: 3,
    });
    expect(researchAuditAfterState(harness)).not.toHaveProperty("revision_id");

    const terminal = harness.queries.findLast((query) =>
      query.text.startsWith("update platform.idempotency_records"),
    );
    expect(terminal?.values).toContain(200);
    expect(
      terminal?.values.find(
        (value) => isRecord(value) && value.operation === "delete_content",
      ),
    ).toEqual({
      version: 1,
      operation: "delete_content",
      decision: "allow",
      status: "succeeded",
      result: {
        content_id: editableContentId,
        lifecycle_state: "deleted",
        resource_version: 3,
      },
      pending_action: null,
      error: null,
    });
  });

  it("freezes an Assisted soft delete with expected_version and keeps its reason private", async () => {
    const sensitiveReason = "Private position-specific liquidation rationale 72a9.";
    const harness = new SqlHarness({ authTier: "assisted" });
    const result = await service(harness).deleteContent(
      agentContext("assisted"),
      deleteInput({ reason: sensitiveReason }),
      { requestId: "req-delete-assisted" },
    );

    expect(result).toMatchObject({
      decision: "require_approval",
      operation: "delete_content",
      pendingAction: {
        approvalSummary: "Soft-delete one ContentItem from version 2.",
        expectedVersion: 2,
        operation: "delete_content",
        state: "pending_approval",
      },
      result: null,
      status: "pending_approval",
    });
    const pendingInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into platform.pending_actions"),
    );
    expect(pendingInsert?.text).toContain("expected_version");
    expect(pendingInsert?.values).toContain(2);
    expect(hasSql(harness, "lifecycle_state = 'deleted'")).toBe(false);
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(false);

    const auditAndOutbox = harness.queries.filter(
      (query) =>
        query.text.startsWith("insert into platform.action_logs") ||
        query.text.startsWith("insert into system.outbox_events"),
    );
    expect(JSON.stringify(auditAndOutbox)).not.toContain(sensitiveReason);
    expect(JSON.stringify(pendingInsert?.values)).not.toContain(sensitiveReason);
    expect(
      auditAndOutbox.find((query) =>
        query.text.startsWith("insert into system.outbox_events"),
      )?.values,
    ).toContain("action.pending_approval");
  });

  it("persists and replays the hard denial for an Agent permanent-delete request", async () => {
    const sensitiveReason = "Account-specific legal erasure rationale.";
    const input = deleteInput({
      idempotencyKey: "permanent-delete-denied",
      mode: "permanent",
      reason: sensitiveReason,
    });
    const command = normalizeDeleteContentCommand(input);
    const firstHarness = new SqlHarness();
    const first = await service(firstHarness).deleteContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-permanent-delete-denied" },
    );

    expect(first).toMatchObject({
      decision: "deny",
      error: {
        code: "POLICY_DENIED",
        details: {
          mode: "permanent",
          rule_version: "author-soft-delete-v1",
        },
        retryable: false,
      },
      operation: "delete_content",
      status: "denied",
    });
    expect(hasSql(firstHarness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(firstHarness, "update platform.idempotency_records")).toBe(true);
    expect(hasSql(firstHarness, "content.current_revision_id")).toBe(false);
    expect(hasSql(firstHarness, "insert into system.outbox_events")).toBe(false);
    expect(JSON.stringify(firstHarness.queries)).not.toContain(sensitiveReason);

    const replayHarness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        response: {
          version: 1,
          operation: "delete_content",
          decision: "deny",
          status: "denied",
          result: null,
          pending_action: null,
          error: first.error,
        },
        status: "denied",
      },
    });
    const replay = await service(replayHarness).deleteContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-permanent-delete-replay" },
    );
    expect(replay).toMatchObject({
      error: { code: "POLICY_DENIED" },
      replayed: true,
      status: "denied",
    });
    expect(hasSql(replayHarness, "content.current_revision_id")).toBe(false);
    expect(hasSql(replayHarness, "insert into platform.action_logs")).toBe(false);
  });

  it.each([
    {
      code: "NOT_CONTENT_AUTHOR",
      options: {
        deleteTarget: {
          actorId: "00000000-0000-4000-8000-000000000099",
        },
      },
    },
    {
      code: "VERSION_CONFLICT",
      options: { deleteTarget: { version: 3 } },
    },
  ] as const)("stores a stable $code delete failure before mutation", async (example) => {
    const harness = new SqlHarness(example.options);
    const result = await service(harness).deleteContent(
      agentContext("autonomous"),
      deleteInput({ idempotencyKey: `delete-${example.code.toLowerCase()}` }),
      { requestId: `req-delete-${example.code.toLowerCase()}` },
    );

    expect(result).toMatchObject({
      decision: "allow",
      error: { code: example.code, retryable: false },
      operation: "delete_content",
      status: "failed",
    });
    expect(hasSql(harness, "lifecycle_state = 'deleted'")).toBe(false);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(harness, "update platform.idempotency_records")).toBe(true);
  });

  it.each(["autonomous", "assisted"] as const)(
    "rejects a %s update that would create a self-reference before persistence",
    async (tier) => {
      const harness = new SqlHarness();
      const result = await service(harness).updateContent(
        agentContext(tier),
        updateInput({
          idempotencyKey: `update-self-reference-${tier}-v3`,
          patch: {
            references: [
              { relationType: "reference", targetContentId: editableContentId },
            ],
          },
        }),
        { requestId: "req-update-self-reference" },
      );

      expect(result).toMatchObject({
        decision: "allow",
        error: {
          code: "VALIDATION_ERROR",
          details: { field: "references", reason_code: "SELF_REFERENCE" },
          retryable: false,
        },
        operation: "update_content",
        status: "failed",
      });
      expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
      expect(hasSql(harness, "insert into platform.content_relations")).toBe(false);
      expect(hasSql(harness, "update platform.content_items")).toBe(false);
    },
  );

  it("rejects a newly added Community placement that is closed to new posts", async () => {
    const harness = new SqlHarness({
      communityRules: {
        [catalogCommunityId]: { maxPostsPerHour: 0 },
      },
    });
    const result = await service(harness).updateContent(
      agentContext("autonomous"),
      updateInput({
        editSummary: undefined,
        idempotencyKey: "update-community-closed-v3",
        patch: {
          additionalCommunityIds: [additionalCommunityId, catalogCommunityId],
        },
      }),
      { requestId: "req-update-community-closed" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      error: {
        code: "COMMUNITY_RESTRICTED",
        details: { community_id: catalogCommunityId },
      },
      operation: "update_content",
      status: "denied",
    });
    expect(hasSql(harness, "update platform.content_items")).toBe(false);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
  });

  it("meters a new Community placement by admission time and preserves retained admission time", async () => {
    const harness = new SqlHarness();
    const result = await service(harness).updateContent(
      agentContext("autonomous"),
      updateInput({
        editSummary: undefined,
        idempotencyKey: "update-community-admission-v3",
        patch: {
          additionalCommunityIds: [additionalCommunityId, catalogCommunityId],
        },
      }),
      { requestId: "req-update-community-admission" },
    );

    expect(result).toMatchObject({ status: "succeeded" });
    const quotaQuery = harness.queries.find(
      (query) =>
        query.text.includes("with admitted as") &&
        query.values.includes(catalogCommunityId),
    );
    expect(quotaQuery?.text).toContain("additional.created_at as admitted_at");

    const placements = harness.queries.filter((query) =>
      query.text.startsWith("insert into platform.content_additional_communities"),
    );
    expect(placements).toHaveLength(2);
    expect(placements[0]?.values).toEqual([
      editableContentId,
      additionalCommunityId,
      1,
      new Date("2026-07-01T00:00:00.000Z"),
    ]);
    expect(placements[1]?.values).toEqual([
      editableContentId,
      catalogCommunityId,
      2,
      now,
    ]);
  });

  it("does not poison an update idempotency key with a temporary rate limit", async () => {
    const input = updateInput({ idempotencyKey: "update-rate-retry-v3" });
    const limitedHarness = new SqlHarness({ updateActorCount: 30 });
    const limited = await service(limitedHarness).updateContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-update-rate-limited" },
    );

    expect(limited).toMatchObject({
      decision: "deny",
      error: { code: "RATE_LIMITED", retryable: true },
      operation: "update_content",
      status: "denied",
    });
    expect(
      limitedHarness.queries.some((query) =>
        query.text.startsWith("update platform.idempotency_records"),
      ),
    ).toBe(false);
    expect(hasSql(limitedHarness, "update platform.content_items")).toBe(false);

    const retryHarness = new SqlHarness();
    const retried = await service(retryHarness).updateContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-update-rate-retried" },
    );
    expect(retried).toMatchObject({
      decision: "allow",
      operation: "update_content",
      status: "succeeded",
    });
  });

  it("freezes an Assisted update with the expected version and does not mutate content", async () => {
    const harness = new SqlHarness({ authTier: "assisted" });
    const input = updateInput();
    const result = await service(harness).updateContent(agentContext("assisted"), input, {
      requestId: "req-update-assisted",
    });

    expect(result).toMatchObject({
      decision: "require_approval",
      status: "pending_approval",
      pendingAction: {
        operation: "update_content",
        expectedVersion: 2,
      },
    });
    const pendingInsert = harness.queries.find((query) =>
      query.text.startsWith("insert into platform.pending_actions"),
    );
    expect(pendingInsert?.text).toContain("expected_version");
    expect(pendingInsert?.values).toContain(2);
    expect(hasSql(harness, "update platform.content_items")).toBe(false);
    expect(hasSql(harness, "insert into platform.content_revisions")).toBe(false);
  });

  it("stores a version conflict as a stable idempotent terminal failure", async () => {
    const input = updateInput({ expectedVersion: 1 });
    const command = normalizeUpdateContentCommand(input);
    const firstHarness = new SqlHarness({ updateTarget: { version: 2 } });
    const first = await service(firstHarness).updateContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-update-version-conflict" },
    );
    expect(first).toMatchObject({
      status: "failed",
      error: {
        code: "VERSION_CONFLICT",
        details: { current_version: 2, expected_version: 1 },
      },
    });
    expect(hasSql(firstHarness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(firstHarness, "update platform.idempotency_records")).toBe(true);

    const replayHarness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        status: "failed",
        response: {
          version: 1,
          operation: "update_content",
          decision: "allow",
          status: "failed",
          result: null,
          pending_action: null,
          error: {
            code: "VERSION_CONFLICT",
            message: "The ContentItem changed after the requested base version.",
            retryable: false,
            details: { current_version: 2, expected_version: 1 },
            retryAfterMs: null,
          },
        },
      },
    });
    const replay = await service(replayHarness).updateContent(
      agentContext("autonomous"),
      input,
      { requestId: "req-update-version-conflict-replay" },
    );
    expect(replay).toMatchObject({ replayed: true, status: "failed" });
    expect(hasSql(replayHarness, "for update of content")).toBe(false);
  });

  it("replays a matching terminal result before re-running Community admission", async () => {
    const command = normalizeCreatePostCommand(postInput());
    const harness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        status: "succeeded",
        response: {
          version: 1,
          operation: "create_post",
          decision: "allow",
          status: "succeeded",
          result: {
            content_id: "00000000-0000-4000-8000-000000000801",
            revision_id: "00000000-0000-4000-8000-000000000802",
            resource_version: 1,
          },
          pending_action: null,
          error: null,
        },
      },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput(),
      { requestId: "req-replay" },
    );

    expect(result).toMatchObject({ replayed: true, status: "succeeded" });
    expect(hasSql(harness, "from platform.communities as community")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("replays a succeeded result after the current policy is tightened to read-only", async () => {
    const command = normalizeCreatePostCommand(postInput());
    const harness = new SqlHarness({
      authTier: "read_only",
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        status: "succeeded",
        response: {
          version: 1,
          operation: "create_post",
          decision: "allow",
          status: "succeeded",
          result: {
            content_id: "00000000-0000-4000-8000-000000000811",
            revision_id: "00000000-0000-4000-8000-000000000812",
            resource_version: 1,
          },
          pending_action: null,
          error: null,
        },
      },
    });

    const result = await service(harness).createPost(
      agentContext("read_only"),
      postInput(),
      { requestId: "req-replay-after-policy-tightening" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      replayed: true,
      status: "succeeded",
    });
    expect(hasSql(harness, "from platform.communities as community")).toBe(false);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(false);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
  });

  it("returns a unified failure when an idempotency key has a different digest", async () => {
    const harness = new SqlHarness({
      existingIdempotency: {
        digest: Buffer.alloc(32, 7),
        status: "succeeded",
        response: {},
      },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput(),
      { requestId: "req-conflict" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      status: "failed",
      result: null,
      pendingAction: null,
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false },
    });
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
  });

  it.each([
    {
      code: "IDEMPOTENCY_IN_PROGRESS",
      response: null,
      status: "in_progress" as const,
    },
    {
      code: "IDEMPOTENCY_RESULT_CORRUPT",
      response: {},
      status: "succeeded" as const,
    },
    {
      code: "IDEMPOTENCY_RESULT_CORRUPT",
      response: {
        version: 1,
        operation: "reply_to_content",
        decision: "allow",
        status: "succeeded",
        result: {
          content_id: "00000000-0000-4000-8000-000000000831",
          root_content_id: "00000000-0000-4000-8000-000000000832",
          revision_id: "00000000-0000-4000-8000-000000000833",
          resource_version: 1,
        },
        pending_action: null,
        error: null,
      },
      status: "succeeded" as const,
    },
    {
      code: "IDEMPOTENCY_RESULT_CORRUPT",
      response: {
        version: 1,
        operation: "create_post",
        decision: "deny",
        status: "denied",
        result: null,
        pending_action: null,
        error: {
          code: "RATE_LIMITED",
          message: "A temporary quota must never be a replayable terminal result.",
          retryable: true,
          details: null,
          retryAfterMs: 60_000,
        },
      },
      status: "denied" as const,
    },
  ])("returns a unified $code failure for an unsafe replay", async (example) => {
    const command = normalizeCreatePostCommand(postInput());
    const harness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        response: example.response,
        status: example.status,
      },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput(),
      { requestId: `req-${example.status}` },
    );

    expect(result).toMatchObject({
      decision: "allow",
      status: "failed",
      error: { code: example.code, retryable: true },
      pendingAction: null,
      result: null,
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("stores a duplicate-content denial and replays it without rerunning discovery", async () => {
    const originalContentId = referenceContentId;
    const input = postInput({ idempotencyKey: "duplicate-post-stable" });
    const command = normalizeCreatePostCommand(input);
    const firstHarness = new SqlHarness({ duplicateContentId: originalContentId });
    const first = await service(firstHarness).createPost(
      agentContext("autonomous"),
      input,
      { requestId: "req-duplicate-post-first" },
    );

    expect(first).toMatchObject({
      decision: "deny",
      error: {
        code: "DUPLICATE_CONTENT",
        details: {
          original_content_id: originalContentId,
          rule_version: "research-anti-spam-v1",
        },
        retryable: false,
      },
      status: "denied",
    });
    const duplicateQuery = firstHarness.queries.find((query) =>
      query.text.includes("original_content_id"),
    );
    expect(duplicateQuery?.text).toContain("revision.created_by_actor_id");
    expect(duplicateQuery?.text).toContain("revision.content_hash");
    expect(duplicateQuery?.values).toContainEqual(
      new Date(now.valueOf() - 24 * 60 * 60 * 1_000),
    );
    expect(hasSql(firstHarness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(firstHarness, "update platform.idempotency_records")).toBe(true);
    expect(hasSql(firstHarness, "insert into platform.content_items")).toBe(false);

    const replayHarness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        response: {
          version: 1,
          operation: "create_post",
          decision: "deny",
          status: "denied",
          result: null,
          pending_action: null,
          error: first.error,
        },
        status: "denied",
      },
    });
    const replay = await service(replayHarness).createPost(
      agentContext("autonomous"),
      input,
      { requestId: "req-duplicate-post-replay" },
    );
    expect(replay).toMatchObject({
      error: { code: "DUPLICATE_CONTENT" },
      replayed: true,
      status: "denied",
    });
    expect(hasSql(replayHarness, "original_content_id")).toBe(false);
    expect(hasSql(replayHarness, "from platform.communities as community")).toBe(false);
    expect(hasSql(replayHarness, "insert into platform.action_logs")).toBe(false);
  });

  it("keeps the Owner post quota transient so the same key can succeed later", async () => {
    const harness = new SqlHarness({
      ownerPostCounts: [20, 0],
      ownerWriteCounts: [0, 0],
    });
    const writer = service(harness);
    const input = postInput({ idempotencyKey: "owner-post-quota-retry" });

    const denied = await writer.createPost(agentContext("autonomous"), input, {
      requestId: "req-owner-post-quota-denied",
    });
    expect(denied).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 20,
          limit_dimension: "owner_post_hour",
          rule_version: "research-anti-spam-v1",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
      status: "denied",
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);

    const succeeded = await writer.createPost(agentContext("autonomous"), input, {
      requestId: "req-owner-post-quota-retry",
    });
    expect(succeeded.status).toBe("succeeded");
    expect(
      harness.queries.filter((query) =>
        query.text.startsWith("insert into platform.idempotency_records"),
      ),
    ).toHaveLength(1);
    expect(
      harness.queries.filter((query) =>
        query.text.startsWith("insert into platform.content_items"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the Owner total-write quota transient across reply retries", async () => {
    const harness = new SqlHarness({
      ownerPostCounts: [0, 0],
      ownerWriteCounts: [120, 0],
    });
    const writer = service(harness);
    const input = {
      bodyMarkdown: "A substantive cross-check against the cited filing.",
      idempotencyKey: "owner-write-quota-retry",
      parentContentId,
    };

    const denied = await writer.replyToContent(agentContext("autonomous"), input, {
      requestId: "req-owner-write-quota-denied",
    });
    expect(denied).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 120,
          limit_dimension: "owner_content_write_hour",
          rule_version: "research-anti-spam-v1",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
      status: "denied",
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);

    const succeeded = await writer.replyToContent(agentContext("autonomous"), input, {
      requestId: "req-owner-write-quota-retry",
    });
    expect(succeeded.status).toBe("succeeded");
    expect(
      harness.queries.filter((query) =>
        query.text.startsWith("insert into platform.idempotency_records"),
      ),
    ).toHaveLength(1);
  });

  it("limits one Agent to twelve replies per discussion per hour", async () => {
    const harness = new SqlHarness({ threadReplyCount: 12 });
    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        bodyMarkdown: "A thirteenth reply in the same discussion.",
        idempotencyKey: "thread-reply-rate-denied",
        parentContentId,
      },
      { requestId: "req-thread-reply-rate-denied" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 12,
          limit_dimension: "actor_thread_reply_hour",
          rule_version: "research-anti-spam-v1",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
      status: "denied",
    });
    expect(hasSql(harness, "join platform.content_items as parent")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("limits a cross-Agent pair to eight replies per discussion in thirty minutes", async () => {
    const harness = new SqlHarness({ pairReplyCount: 8 });
    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        bodyMarkdown: "A ninth direct exchange in this discussion.",
        idempotencyKey: "pair-reply-rate-denied",
        parentContentId,
      },
      { requestId: "req-pair-reply-rate-denied" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 8,
          limit_dimension: "actor_pair_thread_reply_30m",
          rule_version: "research-anti-spam-v1",
        },
        retryAfterMs: 15 * 60 * 1_000,
      },
      status: "denied",
    });
    const pairQuery = harness.queries.find((query) =>
      query.text.includes("join platform.content_items as parent"),
    );
    expect(pairQuery?.text).toContain("reply.author_actor_id");
    expect(pairQuery?.values).toEqual(
      expect.arrayContaining([actorId, mentionedActorId]),
    );
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("bypasses the pair quota for a self-reply while retaining the thread quota", async () => {
    const harness = new SqlHarness({
      pairReplyCount: 8,
      parentAuthorActorId: actorId,
      threadReplyCount: 0,
    });
    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        bodyMarkdown: "A self-follow-up that adds a new primary source.",
        idempotencyKey: "self-reply-pair-bypass",
        parentContentId,
      },
      { requestId: "req-self-reply-pair-bypass" },
    );

    expect(result.status).toBe("succeeded");
    expect(hasSql(harness, "join platform.content_items as parent")).toBe(false);
    expect(
      harness.queries.some((query) =>
        query.values.includes(`alphanet:thread-reply-rate:${actorId}:${rootContentId}`),
      ),
    ).toBe(true);
    expect(
      harness.queries.some((query) =>
        query.values.some(
          (value) => typeof value === "string" && value.includes("pair-reply-rate"),
        ),
      ),
    ).toBe(false);
  });

  it("does not persist idempotency when transaction-locked Community admission is rate limited", async () => {
    const harness = new SqlHarness({ rateCount: 6 });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput(),
      {
        requestId: "req-rate",
      },
    );
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      result: null,
      pendingAction: null,
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        retryAfterMs: 30 * 60 * 1_000,
      },
    });
    expect(
      harness.queries.some((query) =>
        query.values.some(
          (value) => typeof value === "string" && value.includes("community-post-rate"),
        ),
      ),
    ).toBe(true);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("audits an established Agent post denial and lets the same key succeed after the rolling window moves", async () => {
    const harness = new SqlHarness({ agentPostCounts: [6, 0] });
    const writer = service(harness);
    const input = postInput({ idempotencyKey: "agent-post-rate-retry" });

    const denied = await writer.createPost(agentContext("autonomous"), input, {
      requestId: "req-agent-post-rate-denied",
    });
    expect(denied).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 6,
          limit_dimension: "agent_post_hour",
          new_agent_window: false,
          rule_version: "agent-content-rate-v1",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
    });
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "update platform.idempotency_records")).toBe(false);
    const denialAudit = harness.queries.find(
      (query) =>
        query.text.includes("insert into platform.action_logs") &&
        query.values.includes("RATE_LIMITED"),
    );
    expect(denialAudit?.values).toContain("denied");

    const succeeded = await writer.createPost(agentContext("autonomous"), input, {
      requestId: "req-agent-post-rate-retry",
    });
    expect(succeeded.status).toBe("succeeded");
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.idempotency_records"),
      ),
    ).toHaveLength(1);
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.content_items"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      activatedAt: new Date(now.valueOf() - 23 * 60 * 60 * 1_000),
      count: 2,
      expectedLimit: 2,
      expectedNewWindow: true,
      expectedStatus: "denied" as const,
    },
    {
      activatedAt: new Date(now.valueOf() - 24 * 60 * 60 * 1_000),
      count: 2,
      expectedLimit: 6,
      expectedNewWindow: false,
      expectedStatus: "succeeded" as const,
    },
  ])(
    "applies the post threshold at the 24-hour activation boundary ($expectedStatus)",
    async (example) => {
      const harness = new SqlHarness({
        agentActivatedAt: example.activatedAt,
        agentPostCount: example.count,
      });
      const result = await service(harness).createPost(
        agentContext("autonomous"),
        postInput({ idempotencyKey: `activation-boundary-${example.expectedStatus}` }),
        { requestId: `req-activation-boundary-${example.expectedStatus}` },
      );

      expect(result.status).toBe(example.expectedStatus);
      const quotaQuery = harness.queries.find((query) =>
        query.text.includes("as succeeded_count"),
      );
      expect(quotaQuery?.text).toContain("log.agent_id");
      expect(quotaQuery?.text).toContain("log.outcome = 'succeeded'");
      if (example.expectedStatus === "denied") {
        expect(result.error?.details).toMatchObject({
          limit: example.expectedLimit,
          new_agent_window: example.expectedNewWindow,
        });
      }
    },
  );

  it.each([
    {
      activatedAt: new Date(now.valueOf() - 23 * 60 * 60 * 1_000),
      count: 10,
      expectedLimit: 10,
      newAgent: true,
    },
    {
      activatedAt: new Date(now.valueOf() - 25 * 60 * 60 * 1_000),
      count: 30,
      expectedLimit: 30,
      newAgent: false,
    },
  ])("enforces the Agent reply limit (new=$newAgent)", async (example) => {
    const harness = new SqlHarness({
      agentActivatedAt: example.activatedAt,
      agentReplyCount: example.count,
    });
    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        bodyMarkdown: "A substantive counterpoint.",
        idempotencyKey: `reply-rate-${example.newAgent ? "new" : "established"}`,
        parentContentId,
      },
      { requestId: `req-reply-rate-${example.newAgent ? "new" : "established"}` },
    );

    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: example.expectedLimit,
          limit_dimension: "agent_reply_hour",
          new_agent_window: example.newAgent,
        },
      },
    });
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
  });

  it("serializes concurrent Agent post admissions without exceeding the Agent quota", async () => {
    const harness = new SqlHarness({ agentPostCount: 5 });
    const writer = service(harness);
    const results = await Promise.all([
      writer.createPost(
        agentContext("autonomous"),
        postInput({ idempotencyKey: "agent-quota-concurrent-a" }),
        { requestId: "req-agent-quota-concurrent-a" },
      ),
      writer.createPost(
        agentContext("autonomous"),
        postInput({ idempotencyKey: "agent-quota-concurrent-b" }),
        { requestId: "req-agent-quota-concurrent-b" },
      ),
    ]);

    expect(results.filter((result) => result.status === "succeeded")).toHaveLength(1);
    expect(results.find((result) => result.status === "denied")).toMatchObject({
      error: { code: "RATE_LIMITED", details: { limit_dimension: "agent_post_hour" } },
    });
    const lockKey = `alphanet:agent-content-rate:${agentId}:create_post`;
    expect(
      harness.queries.filter((query) => query.values.includes(lockKey)),
    ).toHaveLength(2);
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.content_items"),
      ),
    ).toHaveLength(1);
  });

  it.each(["autonomous", "assisted"] as const)(
    "rejects a %s cross-post when an additional Community has disabled new posts",
    async (tier) => {
      const harness = new SqlHarness({
        authTier: tier,
        communityRules: {
          [communityId]: { maxPostsPerHour: 6 },
          [additionalCommunityId]: { maxPostsPerHour: 0 },
        },
      });

      const result = await service(harness).createPost(
        agentContext(tier),
        postInput({
          additionalCommunityIds: [additionalCommunityId],
          idempotencyKey: `additional-disabled-${tier}`,
        }),
        { requestId: `req-additional-disabled-${tier}` },
      );
      expect(result).toMatchObject({
        decision: "deny",
        status: "denied",
        error: {
          code: "COMMUNITY_RESTRICTED",
          details: { community_id: additionalCommunityId },
        },
      });
      expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(true);
      expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
      expect(hasSql(harness, "update platform.idempotency_records")).toBe(true);
      expect(hasSql(harness, "insert into system.outbox_events")).toBe(false);
      expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
    },
  );

  it("does not materialize a catalog Community when another target hard-denies the post", async () => {
    const harness = new SqlHarness({
      catalogOnly: true,
      communityRules: {
        [additionalCommunityId]: { maxPostsPerHour: 0 },
      },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({
        additionalCommunityIds: [additionalCommunityId],
        idempotencyKey: "catalog-cross-post-denied",
        primaryCommunityId: catalogCommunityId,
      }),
      { requestId: "req-catalog-cross-post-denied" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: { code: "COMMUNITY_RESTRICTED" },
    });
    expect(hasSql(harness, "insert into platform.communities")).toBe(false);
    expect(hasSql(harness, "insert into platform.community_symbols")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
  });

  it("rolls back local admission effects when authoritative reinspection hard-denies", async () => {
    const harness = new SqlHarness({
      catalogOnly: true,
      communityRules: {
        [catalogCommunityId]: { maxPostsPerHour: 0 },
      },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({
        idempotencyKey: "catalog-authoritative-reinspection-denied",
        primaryCommunityId: catalogCommunityId,
      }),
      { requestId: "req-catalog-authoritative-reinspection-denied" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "COMMUNITY_RESTRICTED",
        details: { community_id: catalogCommunityId },
      },
    });
    expect(hasSql(harness, "insert into platform.communities")).toBe(true);
    expect(harness.materialized).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
    expect(hasSql(harness, "insert into platform.content_items")).toBe(false);
  });

  it("counts existing cross-posts against an additional Community quota", async () => {
    const harness = new SqlHarness({
      communityRules: {
        [communityId]: { maxPostsPerHour: 6 },
        [additionalCommunityId]: { maxPostsPerHour: 1 },
      },
      rateCountByCommunity: { [additionalCommunityId]: 1 },
    });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({ additionalCommunityIds: [additionalCommunityId] }),
      { requestId: "req-additional-full" },
    );
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: { community_id: additionalCommunityId },
      },
    });
    const quotaQuery = harness.queries.find(
      (query) =>
        query.text.includes("with admitted as") &&
        query.values.includes(additionalCommunityId),
    );
    expect(quotaQuery?.text).toContain("platform.content_additional_communities");
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("serializes opposite target orders without deadlock or quota oversubscription", async () => {
    const harness = new SqlHarness({
      communityRules: {
        [communityId]: { maxPostsPerHour: 1 },
        [additionalCommunityId]: { maxPostsPerHour: 1 },
      },
    });
    const writer = service(harness);

    const results = await Promise.all([
      writer.createPost(
        agentContext("autonomous"),
        postInput({
          additionalCommunityIds: [additionalCommunityId],
          idempotencyKey: "opposite-order-a",
        }),
        { requestId: "req-opposite-order-a" },
      ),
      writer.createPost(
        agentContext("autonomous"),
        postInput({
          additionalCommunityIds: [communityId],
          idempotencyKey: "opposite-order-b",
          primaryCommunityId: additionalCommunityId,
        }),
        { requestId: "req-opposite-order-b" },
      ),
    ]);

    expect(results.filter((result) => result.status === "succeeded")).toHaveLength(1);
    expect(results.find((result) => result.status === "denied")).toMatchObject({
      decision: "deny",
      status: "denied",
      error: { code: "RATE_LIMITED" },
    });
    const expectedLockKeys = [communityId, additionalCommunityId]
      .sort()
      .map((id) => `alphanet:community-post-rate:${actorId}:${id}`);
    const quotaLockOrders = harness.transactionQueries
      .map((queries) =>
        queries
          .flatMap((query) => query.values)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.includes("community-post-rate:"),
          ),
      )
      .filter((keys) => keys.length > 0);
    expect(quotaLockOrders).toEqual([expectedLockKeys, expectedLockKeys]);
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.content_items"),
      ),
    ).toHaveLength(1);
  });

  it("does not reserve committed Community post quota for an Assisted PendingAction", async () => {
    const harness = new SqlHarness({
      authTier: "assisted",
      communityRules: {
        [communityId]: { maxPostsPerHour: 1 },
        [additionalCommunityId]: { maxPostsPerHour: 1 },
      },
      rateCount: 1,
    });
    const result = await service(harness).createPost(
      agentContext("assisted"),
      postInput({
        additionalCommunityIds: [additionalCommunityId],
        idempotencyKey: "pending-does-not-reserve-community-quota",
      }),
      { requestId: "req-pending-does-not-reserve-community-quota" },
    );

    expect(result.status).toBe("pending_approval");
    expect(hasSql(harness, "with admitted as")).toBe(false);
    expect(hasSql(harness, "as succeeded_count")).toBe(false);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(true);
  });

  it("rejects an Assisted write at the protected-action hourly intent limit", async () => {
    const harness = new SqlHarness({
      authTier: "assisted",
      protectedIntentCount: 20,
    });

    const result = await service(harness).createPost(
      agentContext("assisted"),
      postInput({ idempotencyKey: "protected-intent-hourly-limit" }),
      { requestId: "req-protected-intent-hourly-limit" },
    );
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 20,
          limit_dimension: "protected_action_intent",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(false);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(false);
  });

  it("rejects an Assisted write at the active PendingAction hard limit", async () => {
    const harness = new SqlHarness({
      activePendingCount: 20,
      authTier: "assisted",
    });

    const result = await service(harness).createPost(
      agentContext("assisted"),
      postInput({ idempotencyKey: "active-pending-limit" }),
      { requestId: "req-active-pending-limit" },
    );
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 20,
          limit_dimension: "active_pending_actions",
        },
        retryAfterMs: 30 * 60 * 1_000,
      },
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
  });

  it("serializes concurrent protected-action intents without oversubscribing the limit", async () => {
    const harness = new SqlHarness({ authTier: "assisted" });
    const writer = service(harness, { protectedActionIntentsPerHour: 1 });

    const results = await Promise.all([
      writer.createPost(
        agentContext("assisted"),
        postInput({ idempotencyKey: "protected-intent-concurrent-a" }),
        { requestId: "req-protected-intent-concurrent-a" },
      ),
      writer.createPost(
        agentContext("assisted"),
        postInput({ idempotencyKey: "protected-intent-concurrent-b" }),
        { requestId: "req-protected-intent-concurrent-b" },
      ),
    ]);

    expect(results.filter((result) => result.status === "pending_approval")).toHaveLength(
      1,
    );
    expect(results.find((result) => result.status === "denied")).toMatchObject({
      decision: "deny",
      status: "denied",
      error: {
        code: "RATE_LIMITED",
        details: { limit_dimension: "protected_action_intent" },
      },
    });
    const intentLockKey = `alphanet:protected-action-intent:${agentId}`;
    const intentLocks = harness.transactionQueries
      .map((queries) => queries.flatMap((query) => query.values))
      .flat()
      .filter((value) => value === intentLockKey);
    expect(intentLocks).toHaveLength(2);
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.pending_actions"),
      ),
    ).toHaveLength(1);
    expect(
      harness.queries.filter((query) =>
        query.text.includes("insert into platform.idempotency_records"),
      ),
    ).toHaveLength(1);
  });

  it("replays a matching PendingAction without consuming another protected-action intent", async () => {
    const input = postInput({ idempotencyKey: "pending-intent-replay" });
    const command = normalizeCreatePostCommand(input);
    const harness = new SqlHarness({
      authTier: "assisted",
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        status: "pending_approval",
        response: {
          version: 1,
          operation: "create_post",
          decision: "require_approval",
          status: "pending_approval",
          result: null,
          pending_action: persistedPendingAction(command, "pending_approval"),
          error: null,
        },
      },
    });

    const result = await service(harness).createPost(agentContext("assisted"), input, {
      requestId: "req-pending-intent-replay",
    });

    expect(result).toMatchObject({
      replayed: true,
      status: "pending_approval",
    });
    expect(hasSql(harness, "hourly_intent_count")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
  });

  it.each([
    { state: "approved", status: "pending_approval", error: null, result: null },
    { state: "executing", status: "pending_approval", error: null, result: null },
    {
      state: "succeeded",
      status: "succeeded",
      error: null,
      result: {
        content_id: "00000000-0000-4000-8000-000000000831",
        revision_id: "00000000-0000-4000-8000-000000000832",
        resource_version: 1,
      },
    },
    {
      state: "rejected",
      status: "denied",
      error: {
        code: "ACTION_REJECTED",
        message: "The Owner rejected this action.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      result: null,
    },
    {
      state: "expired",
      status: "denied",
      error: {
        code: "ACTION_EXPIRED",
        message: "The action expired before it could be completed.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      result: null,
    },
    {
      state: "cancelled",
      status: "denied",
      error: {
        code: "ACTION_CANCELLED",
        message: "The action was cancelled.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      result: null,
    },
    {
      state: "failed",
      status: "failed",
      error: {
        code: "ACTION_EXECUTION_FAILED",
        message: "The approved action could not be completed.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      result: null,
    },
    {
      state: "invalidated",
      status: "failed",
      error: {
        code: "ACTION_INVALIDATED",
        message: "The frozen action is no longer valid.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      result: null,
    },
  ] as const)(
    "replays a require-approval outcome while its PendingAction is $state",
    async ({ error, result, state, status }) => {
      const input = postInput({ idempotencyKey: `pending-${state}-replay` });
      const command = normalizeCreatePostCommand(input);
      const harness = new SqlHarness({
        authTier: "assisted",
        existingIdempotency: {
          digest: digestResearchCommandBytes(command),
          status,
          response: {
            version: 1,
            operation: "create_post",
            decision: "require_approval",
            status,
            result,
            pending_action: persistedPendingAction(command, state),
            error,
          },
        },
      });

      const replay = await service(harness).createPost(agentContext("assisted"), input, {
        requestId: `req-pending-${state}-replay`,
      });

      expect(replay).toMatchObject({
        decision: "require_approval",
        replayed: true,
        status,
        pendingAction: { state },
      });
      expect(hasSql(harness, "from platform.communities as community")).toBe(false);
      expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
    },
  );

  it("fails closed when a persisted PendingAction state and write status disagree", async () => {
    const input = postInput({ idempotencyKey: "pending-inconsistent-replay" });
    const command = normalizeCreatePostCommand(input);
    const harness = new SqlHarness({
      authTier: "assisted",
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        status: "succeeded",
        response: {
          version: 1,
          operation: "create_post",
          decision: "require_approval",
          status: "succeeded",
          result: {
            content_id: "00000000-0000-4000-8000-000000000841",
            revision_id: "00000000-0000-4000-8000-000000000842",
            resource_version: 1,
          },
          pending_action: persistedPendingAction(command, "executing"),
          error: null,
        },
      },
    });

    const replay = await service(harness).createPost(agentContext("assisted"), input, {
      requestId: "req-pending-inconsistent-replay",
    });

    expect(replay).toMatchObject({
      error: { code: "IDEMPOTENCY_RESULT_CORRUPT", retryable: true },
      pendingAction: null,
      result: null,
      status: "failed",
    });
  });

  it("persists a policy denial audit without creating an Outbox event", async () => {
    const harness = new SqlHarness({ authTier: "read_only" });
    const result = await service(harness).createPost(
      agentContext("read_only"),
      postInput(),
      { requestId: "req-denied" },
    );

    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: { code: "POLICY_DENIED" },
    });
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(false);
    expect(hasSql(harness, "from platform.communities as community")).toBe(false);
  });

  it("materializes a catalog-only symbol Community only for a committing Autonomous write", async () => {
    const autonomousHarness = new SqlHarness({ catalogOnly: true });
    await service(autonomousHarness).createPost(
      agentContext("autonomous"),
      postInput({ primaryCommunityId: catalogCommunityId }),
      { requestId: "req-catalog-auto" },
    );
    expect(hasSql(autonomousHarness, "insert into platform.communities")).toBe(true);
    expect(hasSql(autonomousHarness, "insert into platform.community_symbols")).toBe(
      true,
    );
    const communityInsert = autonomousHarness.queries.find((query) =>
      query.text.includes("insert into platform.communities"),
    );
    expect(communityInsert?.values).toContain(
      catalogSymbolCommunitySlug("AMD", catalogCommunityId),
    );

    const assistedHarness = new SqlHarness({ authTier: "assisted", catalogOnly: true });
    const pending = await service(assistedHarness).createPost(
      agentContext("assisted"),
      postInput({ primaryCommunityId: catalogCommunityId }),
      { requestId: "req-catalog-assisted" },
    );
    expect(pending.status).toBe("pending_approval");
    expect(hasSql(assistedHarness, "insert into platform.communities")).toBe(false);
    expect(hasSql(assistedHarness, "insert into platform.content_items")).toBe(false);
  });

  it.each([
    {
      label: "disallowed research category",
      options: { allowedContent: ["question"] },
      error: "COMMUNITY_RESTRICTED",
      decision: "deny",
      persisted: true,
      status: "denied",
    },
    {
      label: "missing required source",
      options: { requiresSources: true },
      error: "VALIDATION_ERROR",
      decision: "allow",
      persisted: false,
      status: "failed",
    },
  ])(
    "enforces $label before idempotency admission",
    async ({ options, error, decision, persisted, status }) => {
      const harness = new SqlHarness(options);
      const result = await service(harness).createPost(
        agentContext("autonomous"),
        postInput(),
        { requestId: "req-rule" },
      );
      expect(result).toMatchObject({
        decision,
        status,
        error: { code: error },
        pendingAction: null,
        result: null,
      });
      expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(persisted);
      expect(hasSql(harness, "insert into platform.action_logs")).toBe(persisted);
    },
  );

  it("returns a unified not-found failure after Community dispatch", async () => {
    const harness = new SqlHarness({ missingCommunityIds: [communityId] });

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput(),
      { requestId: "req-community-missing" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      status: "failed",
      error: {
        code: "COMMUNITY_NOT_FOUND",
        details: { community_id: communityId },
      },
      pendingAction: null,
      result: null,
    });
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("retains require_approval when an Assisted dispatch fails validation", async () => {
    const harness = new SqlHarness({ authTier: "assisted", requiresSources: true });

    const result = await service(harness).createPost(
      agentContext("assisted"),
      postInput({ idempotencyKey: "assisted-source-required" }),
      { requestId: "req-assisted-source-required" },
    );

    expect(result).toMatchObject({
      decision: "require_approval",
      status: "failed",
      error: { code: "VALIDATION_ERROR" },
      pendingAction: null,
      result: null,
    });
    expect(hasSql(harness, "insert into platform.pending_actions")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
  });

  it("maps normalized command text errors to a unified validation failure", async () => {
    const harness = new SqlHarness();

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({ bodyMarkdown: "invalid\u0000research" }),
      { requestId: "req-command-nul" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      status: "failed",
      error: {
        code: "VALIDATION_ERROR",
        details: { reason_code: "TEXT_INVALID" },
      },
      pendingAction: null,
      result: null,
    });
    expect(harness.transactionCount).toBe(0);
  });

  it.each(["autonomous", "assisted"] as const)(
    "rejects an adversarial %s post mention set before opening a transaction",
    async (tier) => {
      const harness = new SqlHarness({ authTier: tier });
      const bodyMarkdown = Array.from(
        { length: 10_000 },
        (_, index) => `@a${index.toString(36).padStart(3, "0")}`,
      ).join(" ");

      const result = await service(harness).createPost(
        agentContext(tier),
        postInput({ bodyMarkdown, idempotencyKey: `mentions-${tier}` }),
        { requestId: `req-mentions-${tier}` },
      );

      expect(result).toMatchObject({
        decision: tier === "assisted" ? "require_approval" : "allow",
        status: "failed",
        error: {
          code: "VALIDATION_ERROR",
          details: { field: "body_markdown" },
        },
        pendingAction: null,
        result: null,
      });
      expect(harness.transactionCount).toBe(0);
      expect(harness.queries).toEqual([]);
    },
  );

  it("applies the same bounded mention validation to replies", async () => {
    const harness = new SqlHarness();
    const bodyMarkdown = Array.from(
      { length: 101 },
      (_, index) => `@reply-${index.toString(36).padStart(2, "0")}`,
    ).join(" ");

    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        parentContentId,
        bodyMarkdown,
        idempotencyKey: "reply-v1",
      },
      { requestId: "req-reply-mentions" },
    );

    expect(result).toMatchObject({
      decision: "allow",
      status: "failed",
      error: {
        code: "VALIDATION_ERROR",
        details: { field: "body_markdown" },
      },
    });
    expect(harness.transactionCount).toBe(0);
    expect(harness.queries).toEqual([]);
  });

  it("never sends more than 100 canonical mention candidates to PostgreSQL", async () => {
    const harness = new SqlHarness();
    const bodyMarkdown = Array.from(
      { length: 100 },
      (_, index) => `@candidate-${index.toString(36).padStart(2, "0")}`,
    ).join(" ");

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({ bodyMarkdown, idempotencyKey: "mentions-at-limit" }),
      { requestId: "req-mentions-at-limit" },
    );

    expect(result.status).toBe("succeeded");
    const lookup = harness.queries.find((query) =>
      query.text.includes("lower(actor.handle::text) as handle"),
    );
    expect(lookup?.values[0]).toEqual(
      Array.from(
        { length: 100 },
        (_, index) => `candidate-${index.toString(36).padStart(2, "0")}`,
      ),
    );
  });

  it("rejects structurally pathological Markdown before opening a transaction", async () => {
    const harness = new SqlHarness();

    const result = await service(harness).createPost(
      agentContext("autonomous"),
      postInput({
        bodyMarkdown: "<x\n".repeat(4_100),
        idempotencyKey: "markdown-complexity-v1",
      }),
      { requestId: "req-markdown-complexity" },
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "VALIDATION_ERROR",
        details: {
          field: "body_markdown",
          reason_code: "MARKDOWN_TOO_COMPLEX",
        },
      },
    });
    expect(harness.transactionCount).toBe(0);
    expect(harness.queries).toEqual([]);
  });

  it("inherits all root Communities and rejects a reply when any closes discussion", async () => {
    const harness = new SqlHarness({ repliesOpen: false });

    const result = await service(harness).replyToContent(
      agentContext("autonomous"),
      {
        parentContentId,
        bodyMarkdown: "A substantive counterpoint.",
        idempotencyKey: "reply-v1",
      },
      { requestId: "req-reply-closed" },
    );
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      error: { code: "REPLIES_CLOSED" },
      pendingAction: null,
      result: null,
    });
    expect(
      harness.queries.filter((query) =>
        query.text.includes("from platform.communities as community"),
      ),
    ).toHaveLength(2);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(true);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(true);
    expect(hasSql(harness, "update platform.idempotency_records")).toBe(true);
    expect(hasSql(harness, "insert into system.outbox_events")).toBe(false);
  });

  it("replays a stable platform-rule denial before rechecking an opened Community", async () => {
    const input = postInput({ idempotencyKey: "stable-community-denial" });
    const command = normalizeCreatePostCommand(input);
    const harness = new SqlHarness({
      existingIdempotency: {
        digest: digestResearchCommandBytes(command),
        response: {
          version: 1,
          operation: "create_post",
          decision: "deny",
          status: "denied",
          result: null,
          pending_action: null,
          error: {
            code: "COMMUNITY_RESTRICTED",
            message: "The requested Community is not accepting writes.",
            retryable: false,
            details: { community_id: communityId },
            retryAfterMs: null,
          },
        },
        status: "denied",
      },
    });

    const replay = await service(harness).createPost(agentContext("autonomous"), input, {
      requestId: "req-stable-community-denial-replay",
    });

    expect(replay).toMatchObject({
      decision: "deny",
      status: "denied",
      replayed: true,
      error: { code: "COMMUNITY_RESTRICTED" },
    });
    expect(hasSql(harness, "from platform.communities as community")).toBe(false);
    expect(hasSql(harness, "insert into platform.idempotency_records")).toBe(false);
    expect(hasSql(harness, "insert into platform.action_logs")).toBe(false);
  });

  it("rejects missing content scope before opening a database transaction", async () => {
    const harness = new SqlHarness();
    const context = agentContext("autonomous");
    context.credential.scopes = ["research:read"];

    await expect(
      service(harness).createPost(context, postInput(), {
        requestId: "req-scope",
      }),
    ).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(harness.transactionCount).toBe(0);
  });
});
