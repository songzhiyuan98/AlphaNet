import { randomBytes } from "node:crypto";

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
  normalizeCreatePostCommand,
  normalizeReplyCommand,
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
  type PostgresResearchWriteOptions,
} from "./research-write.js";
import { PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

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
  activePendingCount?: number | undefined;
  protectedIntentCount?: number | undefined;
  rateCount?: number | undefined;
  rateCountByCommunity?: Record<string, number> | undefined;
  repliesOpen?: boolean | undefined;
  requiresSources?: boolean | undefined;
}

interface HarnessTransaction {
  createdPendingAction: boolean;
  quotaCommunityIds: Set<string>;
  queries: CapturedQuery[];
  releases: (() => void)[];
}

class SqlHarness {
  readonly queries: CapturedQuery[] = [];
  readonly sql: PostgresClient;
  readonly transactionQueries: CapturedQuery[][] = [];
  transactionCount = 0;
  #activePendingCount = 0;
  readonly #admittedCounts = new Map<string, number>();
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
          credential_scopes: ["content:write"],
          credential_policy_ceiling: "autonomous",
          defaults_version: "agent-permission-defaults-v1",
          policy_id: policyId,
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
    if (text.includes("from platform.content_items as parent")) {
      return [
        {
          depth: 0,
          parent_lifecycle_state: "published",
          parent_distribution_state: "normal",
          root_id: rootContentId,
          root_lifecycle_state: "published",
          root_distribution_state: "normal",
          primary_community_id: communityId,
        },
      ];
    }
    if (text.includes("from platform.content_additional_communities")) {
      return [{ community_id: additionalCommunityId }];
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
    if (text.startsWith("insert into") || text.startsWith("update platform")) {
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
    "activePendingActionsPerAgent" | "protectedActionIntentsPerHour"
  > = {},
): PostgresResearchWriteService {
  return new PostgresResearchWriteService(harness.sql, {
    clock: () => new Date(now.valueOf()),
    idFactory: idFactory(),
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
    ...options,
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
      expectedVersion: null,
      expiresAt: new Date(now.valueOf() + 60 * 60 * 1_000),
      failureCount: 0,
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
          : command.parentContentId,
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

describe("PostgresResearchWriteService", () => {
  it("pins readiness to migrations 000006/000007 and the critical write schema", async () => {
    const harness = new SqlHarness();
    await service(harness).checkReady();

    const readiness = harness.queries.find((query) =>
      query.text.includes("system.schema_migrations"),
    );
    expect(readiness?.values).toContain(COMMUNITY_RESEARCH_MIGRATION_CHECKSUM);
    expect(readiness?.values).toContain(PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM);
    expect(readiness?.text).toContain("platform.content_items");
    expect(readiness?.text).toContain("platform.pending_actions");
    expect(readiness?.text).toContain("content_revisions_prevent_mutation");
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

  it("returns a sanitized retry disposition when approved execution hits a live rate gate", async () => {
    const harness = new SqlHarness({
      authTier: "assisted",
      maxPostsPerHour: 6,
      rateCount: 6,
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
