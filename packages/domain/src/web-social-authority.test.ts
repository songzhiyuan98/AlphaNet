import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  type AgentOperation,
  type AgentPolicyDecision,
  type AgentPolicyRules,
} from "./agent-policy.js";
import type { AgentPolicyTier, AgentPolicyView } from "./agent-connection.js";
import {
  createOwnerWebContextAuthority,
  OwnerWebSessionContextError,
  type OwnerWebMutationContext,
} from "./owner-web-session-context.js";
import { OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM } from "./schema-migrations.js";
import {
  evaluateOwnerDirectOperation,
  PostgresWebSocialAuthorityResolver,
  WebSocialAuthorityError,
  type OwnerDirectAgentAuthority,
  type WebSocialAuthority,
  type WebSocialAuthoritySelection,
} from "./web-social-authority.js";

const checkedAt = new Date("2026-07-22T18:00:00.000Z");
const createdAt = new Date("2026-07-01T18:00:00.000Z");
const ownerId = "10000000-0000-4000-8000-000000000001";
const otherOwnerId = "10000000-0000-4000-8000-000000000002";
const sessionId = "11000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const agentActorId = "30000000-0000-4000-8000-000000000001";
const otherActorId = "30000000-0000-4000-8000-000000000002";
const humanActorId = "40000000-0000-4000-8000-000000000001";
const policyId = "50000000-0000-4000-8000-000000000001";
const contextAuthority = createOwnerWebContextAuthority();

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface FakePostgresOptions {
  agentRows?: readonly unknown[];
  authorityTimeRows?: readonly unknown[];
  humanRows?: readonly unknown[];
  ownerRows?: readonly unknown[];
  readinessRows?: readonly unknown[];
  rejectAuthority?: boolean;
}

function fakePostgres(options: FakePostgresOptions = {}): {
  beginCallCount: () => number;
  calls: CapturedQuery[];
  sql: PostgresClient;
  transaction: postgres.TransactionSql;
} {
  let beginCallCount = 0;
  const calls: CapturedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    if (query.text.includes("set local statement_timeout")) return Promise.resolve([]);
    if (query.text.includes("as ready")) {
      return Promise.resolve(options.readinessRows ?? [{ ready: true }]);
    }
    if (query.text.includes("select statement_timestamp() as authority_checked_at")) {
      return Promise.resolve(
        options.authorityTimeRows ?? [{ authority_checked_at: checkedAt }],
      );
    }
    if (query.text.includes("from platform.owners as owner")) {
      if (options.rejectAuthority) {
        return Promise.reject(new Error("database unavailable"));
      }
      return Promise.resolve(options.ownerRows ?? [validOwnerRow()]);
    }
    if (query.text.includes("from platform.agents as agent")) {
      return Promise.resolve(options.agentRows ?? [validAgentRow()]);
    }
    if (query.text.includes("from platform.actors as actor")) {
      return Promise.resolve(options.humanRows ?? [validHumanRow()]);
    }
    return Promise.reject(new Error(`Unexpected query: ${query.text}`));
  };
  Object.assign(tag, {
    begin: async <T>(callback: (transaction: typeof tag) => Promise<T>): Promise<T> => {
      beginCallCount += 1;
      return callback(tag);
    },
  });
  return {
    beginCallCount: () => beginCallCount,
    calls,
    sql: tag as unknown as PostgresClient,
    transaction: tag as unknown as postgres.TransactionSql,
  };
}

function validOwnerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ownerId,
    status: "active",
    email_verified_at: createdAt,
    deleted_at: null,
    ...overrides,
  };
}

function mutationContext(
  overrides: Record<string, unknown> = {},
): OwnerWebMutationContext {
  return contextAuthority.issuer.issueMutationContext({
    ownerId,
    sessionId,
    requestId: "req-owner-web-social",
    authenticatedAt: createdAt,
    authenticationAssurance: "owner_session",
    ...overrides,
  });
}

function sessionContext(overrides: Record<string, unknown> = {}) {
  return contextAuthority.issuer.issueSessionContext({
    ownerId,
    sessionId,
    requestId: "req-owner-web-social",
    authenticatedAt: createdAt,
    authenticationAssurance: "owner_session",
    ...overrides,
  });
}

function rawMutationContext(
  overrides: Record<string, unknown> = {},
): OwnerWebMutationContext {
  return {
    ownerId,
    sessionId,
    requestId: "req-owner-web-social",
    authenticatedAt: createdAt,
    authenticationAssurance: "owner_session",
    csrfValidated: true,
    ...overrides,
  } as unknown as OwnerWebMutationContext;
}

function validHumanRow(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: humanActorId,
    actor_owner_id: ownerId,
    actor_kind: "human",
    actor_handle: "market-researcher",
    actor_display_name: "Market Researcher",
    actor_bio: "Independent market researcher.",
    actor_status: "active",
    actor_created_at: createdAt,
    actor_updated_at: createdAt,
    actor_deleted_at: null,
    ...overrides,
  };
}

function validAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: agentId,
    agent_actor_id: agentActorId,
    agent_owner_id: ownerId,
    agent_discovery_tags: ["semiconductors", "risk"],
    agent_status: "active",
    agent_restriction_reason_code: null,
    agent_credential_count: 2,
    agent_created_at: createdAt,
    agent_updated_at: createdAt,
    agent_activated_at: createdAt,
    agent_archived_at: null,
    agent_deleted_at: null,
    actor_id: agentActorId,
    actor_owner_id: ownerId,
    actor_kind: "agent",
    actor_handle: "alpha-research-agent",
    actor_display_name: "Alpha Research Agent",
    actor_bio: "Cross-validates investment research.",
    actor_status: "active",
    actor_created_at: createdAt,
    actor_updated_at: createdAt,
    actor_deleted_at: null,
    policy_id: policyId,
    policy_agent_id: agentId,
    policy_tier: "assisted",
    policy_defaults_version: "agent-permission-defaults-v1",
    policy_schema_version: 1,
    policy_version: "4",
    policy_rules: {},
    policy_effective_from: createdAt,
    policy_is_active: true,
    policy_owner_id: ownerId,
    ...overrides,
  };
}

function ownerDirectSelection(
  overrides: Record<string, unknown> = {},
): WebSocialAuthoritySelection {
  return {
    agentId,
    kind: "owner_direct",
    ...overrides,
  } as unknown as WebSocialAuthoritySelection;
}

function humanDirectSelection(
  overrides: Record<string, unknown> = {},
): WebSocialAuthoritySelection {
  return {
    actorId: humanActorId,
    kind: "human_direct",
    ...overrides,
  } as unknown as WebSocialAuthoritySelection;
}

async function expectAuthorityError(
  database: ReturnType<typeof fakePostgres>,
  selection: WebSocialAuthoritySelection,
  code: "AUTHORITY_NOT_FOUND" | "INVALID_AUTHORITY_SELECTION" | "OWNER_NOT_ELIGIBLE",
  context: OwnerWebMutationContext = mutationContext(),
): Promise<WebSocialAuthorityError> {
  const resolver = new PostgresWebSocialAuthorityResolver(
    database.sql,
    contextAuthority.verifier,
  );
  const error = await Promise.resolve()
    .then(() =>
      resolver.resolveAuthorityInTransaction(database.transaction, context, selection),
    )
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebSocialAuthorityError);
  expect(error).toMatchObject({ code });
  return error as WebSocialAuthorityError;
}

async function resolveFakeAuthority(
  database: ReturnType<typeof fakePostgres>,
  context: OwnerWebMutationContext,
  selection: WebSocialAuthoritySelection,
): Promise<WebSocialAuthority> {
  return new PostgresWebSocialAuthorityResolver(
    database.sql,
    contextAuthority.verifier,
  ).resolveAuthorityInTransaction(database.transaction, context, selection);
}

async function resolvedOwnerDirectAuthority(
  options: FakePostgresOptions = {},
): Promise<OwnerDirectAgentAuthority> {
  const database = fakePostgres(options);
  const authority = await resolveFakeAuthority(
    database,
    mutationContext(),
    ownerDirectSelection(),
  );
  if (authority.kind !== "owner_direct") {
    throw new Error("Expected owner-direct authority");
  }
  return authority;
}

async function resolvedAuthorityWithPolicy(
  tier: AgentPolicyTier,
  operations: AgentPolicyRules["operations"] = {},
  metadata: Partial<Pick<AgentPolicyView, "defaultsVersion" | "schemaVersion">> = {},
): Promise<OwnerDirectAgentAuthority> {
  return resolvedOwnerDirectAuthority({
    agentRows: [
      validAgentRow({
        policy_defaults_version:
          metadata.defaultsVersion ?? "agent-permission-defaults-v1",
        policy_rules: tier === "custom" ? operations : {},
        policy_schema_version: metadata.schemaVersion ?? 1,
        policy_tier: tier,
      }),
    ],
  });
}

describe("PostgresWebSocialAuthorityResolver", () => {
  it("pins readiness to migration 000021 and its authority guards", async () => {
    const { calls, sql } = fakePostgres();
    await new PostgresWebSocialAuthorityResolver(
      sql,
      contextAuthority.verifier,
    ).checkReady();

    expect(calls[0]?.text).toContain("set local statement_timeout");
    const readiness = calls.find((call) => call.text.includes("as ready"));
    expect(readiness?.text).toContain("version = '000021'");
    expect(readiness?.text).toContain("name = 'owner_web_social_v1'");
    expect(readiness?.text).toContain("validate_domain_write_subject");
    expect(readiness?.text).toContain("validate_runtime_content_write_provenance");
    expect(readiness?.text).toContain("action_logs_validate_domain_write_subject");
    expect(readiness?.text).toContain("content_items_validate_runtime_provenance");
    expect(readiness?.text).toContain(
      "content_additional_communities_validate_runtime_provenance",
    );
    expect(readiness?.text).toContain("content_symbols_validate_runtime_provenance");
    expect(readiness?.text).toContain("content_topics_validate_runtime_provenance");
    expect(readiness?.text).toContain("source_links_validate_runtime_provenance");
    expect(readiness?.text).toContain("content_relations_validate_runtime_provenance");
    expect(readiness?.text).toContain("mentions_validate_runtime_provenance");
    expect(readiness?.text).toContain("provenance_trigger.tgdeferrable");
    expect(readiness?.text).toContain("provenance_trigger.tginitdeferred");
    expect(readiness?.values).toContain(OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM);
  });

  it("fails readiness closed with a stable 503 error", async () => {
    const resolver = new PostgresWebSocialAuthorityResolver(
      fakePostgres({ readinessRows: [{ ready: false }] }).sql,
      contextAuthority.verifier,
    );
    await expect(resolver.checkReady()).rejects.toMatchObject({
      code: "SCHEMA_NOT_READY",
      name: "WebSocialAuthorityError",
      retryable: true,
      statusCode: 503,
    });
  });

  it("resolves a credential-free owner-direct Agent under an Owner-first lock", async () => {
    const database = fakePostgres();
    const authority = await resolveFakeAuthority(
      database,
      mutationContext(),
      ownerDirectSelection(),
    );
    const { calls } = database;

    expect(authority).toMatchObject({
      kind: "owner_direct",
      owner: { id: ownerId },
      actor: {
        id: agentActorId,
        ownerId,
        kind: "agent",
        status: "active",
      },
      agent: {
        id: agentId,
        actorId: agentActorId,
        ownerId,
        status: "active",
        policy: {
          id: policyId,
          tier: "assisted",
          version: "4",
        },
      },
      currentPolicy: {
        id: policyId,
        tier: "assisted",
        version: "4",
      },
      credential: null,
      channel: "web",
      approvalMethod: "owner_direct",
      principalScopeKey: `owner_direct:${ownerId}:${agentId}`,
      requestContext: {
        ownerId,
        requestId: "req-owner-web-social",
        authenticatedAt: createdAt,
        authenticationAssurance: "owner_session",
        csrfValidated: true,
        channel: "web",
      },
      authorityCheckedAt: checkedAt,
    });
    if (authority.kind !== "owner_direct") throw new Error("Wrong authority kind");
    expect(authority.agent.policy).toBe(authority.currentPolicy);
    expect(authority.currentPolicy.rules.operations.content_write).toBe(
      "require_approval",
    );

    const timeIndex = calls.findIndex((call) =>
      call.text.includes("select statement_timestamp() as authority_checked_at"),
    );
    const ownerIndex = calls.findIndex((call) =>
      call.text.includes("from platform.owners as owner"),
    );
    const agentIndex = calls.findIndex((call) =>
      call.text.includes("from platform.agents as agent"),
    );
    expect(timeIndex).toBeGreaterThanOrEqual(0);
    expect(ownerIndex).toBeGreaterThan(timeIndex);
    expect(agentIndex).toBeGreaterThan(ownerIndex);
    expect(calls[ownerIndex]?.text).toContain("for share of owner");
    expect(calls[agentIndex]?.text).toContain("for share of agent, actor, policy");
    expect(calls[agentIndex]?.values).toEqual([agentId]);
    expect(calls[agentIndex]?.values).not.toContain(agentActorId);
  });

  it("keeps authority locks in the caller's transaction without opening its own", async () => {
    const outer = fakePostgres();
    const bound = fakePostgres();
    const authority = await new PostgresWebSocialAuthorityResolver(
      outer.sql,
      contextAuthority.verifier,
    ).resolveAuthorityInTransaction(
      bound.transaction,
      mutationContext(),
      ownerDirectSelection(),
    );

    expect(authority).toMatchObject({
      kind: "owner_direct",
      owner: { id: ownerId },
      actor: { id: agentActorId, kind: "agent" },
      agent: { id: agentId },
    });
    expect(outer.beginCallCount()).toBe(0);
    expect(outer.calls).toHaveLength(0);
    expect(bound.beginCallCount()).toBe(0);
    const ownerLockIndex = bound.calls.findIndex((call) =>
      call.text.includes("from platform.owners as owner"),
    );
    const authorityLockIndex = bound.calls.findIndex((call) =>
      call.text.includes("from platform.agents as agent"),
    );
    expect(ownerLockIndex).toBeGreaterThanOrEqual(0);
    expect(authorityLockIndex).toBeGreaterThan(ownerLockIndex);
    expect(bound.calls[ownerLockIndex]?.text).toContain("for share of owner");
    expect(bound.calls[authorityLockIndex]?.text).toContain(
      "for share of agent, actor, policy",
    );
  });

  it("exposes no resolver path that releases write locks before returning", () => {
    const resolver = new PostgresWebSocialAuthorityResolver(
      fakePostgres().sql,
      contextAuthority.verifier,
    );
    expect(resolver).not.toHaveProperty("resolveAuthority");
    expect(typeof resolver.resolveAuthorityInTransaction).toBe("function");
  });

  it.each([
    [
      "stale Owner",
      { ownerRows: [validOwnerRow({ status: "suspended" })] },
      "OWNER_NOT_ELIGIBLE",
      403,
    ],
    [
      "cross-Owner Agent",
      { agentRows: [validAgentRow({ agent_owner_id: otherOwnerId })] },
      "AUTHORITY_NOT_FOUND",
      404,
    ],
  ] as const)(
    "matches transaction-bound rejection for %s without beginning an outer transaction",
    async (_label, options, code, statusCode) => {
      const outer = fakePostgres();
      const bound = fakePostgres(options);
      const boundError = await new PostgresWebSocialAuthorityResolver(
        outer.sql,
        contextAuthority.verifier,
      )
        .resolveAuthorityInTransaction(
          bound.transaction,
          mutationContext(),
          ownerDirectSelection(),
        )
        .catch((caught: unknown) => caught);

      expect(boundError).toMatchObject({ code, statusCode });
      expect(outer.beginCallCount()).toBe(0);
      expect(outer.calls).toHaveLength(0);
      expect(bound.beginCallCount()).toBe(0);
      expect(bound.calls[0]?.text).toContain(
        "select statement_timestamp() as authority_checked_at",
      );
      expect(bound.calls.some((call) => call.text.includes("for share of owner"))).toBe(
        true,
      );
    },
  );

  it("resolves a human-direct authority without Agent policy or Credential identity", async () => {
    const database = fakePostgres();
    const authority = await resolveFakeAuthority(
      database,
      mutationContext(),
      humanDirectSelection(),
    );

    expect(authority).toEqual({
      kind: "human_direct",
      owner: { id: ownerId },
      actor: {
        id: humanActorId,
        ownerId,
        kind: "human",
        handle: "market-researcher",
        displayName: "Market Researcher",
        bio: "Independent market researcher.",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
      agent: null,
      currentPolicy: null,
      credential: null,
      channel: "web",
      approvalMethod: "human_direct",
      principalScopeKey: `human_web:${ownerId}:${humanActorId}`,
      requestContext: {
        ownerId,
        requestId: "req-owner-web-social",
        authenticatedAt: createdAt,
        authenticationAssurance: "owner_session",
        csrfValidated: true,
        channel: "web",
      },
      authorityCheckedAt: checkedAt,
    });
  });

  it("strictly rejects malformed or ambiguous selections before PostgreSQL", async () => {
    const malformed = [
      null,
      ownerDirectSelection({ extra: "not-allowed" }),
      ownerDirectSelection({ kind: "agent" }),
      ownerDirectSelection({ ownerId }),
      ownerDirectSelection({ ownerId: "not-a-uuid" }),
      ownerDirectSelection({ agentId: undefined }),
      ownerDirectSelection({
        agentId: "20000000-0000-4000-8000-00000000000a".toUpperCase(),
      }),
      ownerDirectSelection({ actorId: agentActorId }),
      humanDirectSelection({ agentId }),
      humanDirectSelection({ ownerId }),
      humanDirectSelection({ kind: "owner_direct" }),
    ] as unknown as WebSocialAuthoritySelection[];

    for (const selection of malformed) {
      const database = fakePostgres();
      const error = await expectAuthorityError(
        database,
        selection,
        "INVALID_AUTHORITY_SELECTION",
      );
      expect(error.statusCode).toBe(400);
      expect(database.calls).toHaveLength(0);
    }
  });

  it.each([
    [
      "fake authentication timestamp",
      rawMutationContext({ authenticatedAt: createdAt.toISOString() }),
      "INVALID_OWNER_WEB_SESSION_CONTEXT",
      400,
    ],
    [
      "future authentication timestamp",
      mutationContext({
        authenticatedAt: new Date(checkedAt.valueOf() + 1),
      }),
      "OWNER_WEB_AUTHENTICATION_TIME_INVALID",
      401,
    ],
    [
      "missing CSRF fact",
      sessionContext() as unknown as OwnerWebMutationContext,
      "OWNER_WEB_CSRF_REQUIRED",
      403,
    ],
    [
      "false CSRF fact",
      rawMutationContext({ csrfValidated: false }),
      "INVALID_OWNER_WEB_SESSION_CONTEXT",
      400,
    ],
    [
      "unknown context field",
      rawMutationContext({ cookie: "private-owner-cookie" }),
      "INVALID_OWNER_WEB_SESSION_CONTEXT",
      400,
    ],
    [
      "foreign authority context",
      createOwnerWebContextAuthority().issuer.issueMutationContext({
        ownerId,
        sessionId,
        requestId: "req-foreign-web-social-authority",
        authenticatedAt: createdAt,
        authenticationAssurance: "owner_session",
      }),
      "INVALID_OWNER_WEB_SESSION_CONTEXT",
      400,
    ],
  ] as const)(
    "gets database time then rejects %s before locking an Owner",
    async (_label, context, code, statusCode) => {
      const database = fakePostgres();
      const error = await resolveFakeAuthority(
        database,
        context,
        ownerDirectSelection(),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OwnerWebSessionContextError);
      expect(error).toMatchObject({ code, statusCode });
      expect(database.calls).toHaveLength(1);
      expect(database.calls[0]?.text).toContain(
        "select statement_timestamp() as authority_checked_at",
      );
      expect(database.calls[0]?.text).not.toContain("platform.owners");
      expect(JSON.stringify(error)).not.toContain("private-owner-cookie");
    },
  );

  it("derives Owner authority only from the normalized mutation context", async () => {
    const database = fakePostgres();
    const error = await expectAuthorityError(
      database,
      ownerDirectSelection(),
      "OWNER_NOT_ELIGIBLE",
      mutationContext({ ownerId: otherOwnerId }),
    );

    expect(error.statusCode).toBe(403);
    const ownerLock = database.calls.find((call) =>
      call.text.includes("from platform.owners as owner"),
    );
    expect(ownerLock?.values).toContain(otherOwnerId);
    expect(ownerLock?.values).not.toContain(ownerId);
  });

  it("returns detached authority timestamps without exposing the internal session", async () => {
    const sourceAuthenticationTime = new Date(createdAt.valueOf());
    const authority = await resolveFakeAuthority(
      fakePostgres(),
      mutationContext({ authenticatedAt: sourceAuthenticationTime }),
      ownerDirectSelection(),
    );

    sourceAuthenticationTime.setTime(sourceAuthenticationTime.valueOf() - 60_000);
    expect(authority.requestContext.authenticatedAt).toEqual(createdAt);
    const returnedAuthenticationTime = authority.requestContext.authenticatedAt;
    returnedAuthenticationTime.setTime(returnedAuthenticationTime.valueOf() - 60_000);
    expect(authority.requestContext.authenticatedAt).toEqual(createdAt);

    const returnedCheckedAt = authority.authorityCheckedAt;
    returnedCheckedAt.setTime(returnedCheckedAt.valueOf() - 60_000);
    expect(authority.authorityCheckedAt).toEqual(checkedAt);
    expect(authority.requestContext).not.toHaveProperty("sessionId");
    expect(JSON.stringify(authority)).not.toContain(sessionId);
  });

  it("returns a deeply detached and frozen authority graph", async () => {
    const sourceActorCreatedAt = new Date(createdAt);
    const sourceAgentCreatedAt = new Date(createdAt);
    const sourcePolicyEffectiveFrom = new Date(createdAt);
    const row = validAgentRow({
      actor_created_at: sourceActorCreatedAt,
      agent_created_at: sourceAgentCreatedAt,
      policy_effective_from: sourcePolicyEffectiveFrom,
    });
    const sourceTags = row.agent_discovery_tags;
    const authority = await resolveFakeAuthority(
      fakePostgres({ agentRows: [row] }),
      mutationContext(),
      ownerDirectSelection(),
    );
    if (authority.kind !== "owner_direct") throw new Error("Wrong authority kind");

    for (const frozen of [
      authority,
      authority.owner,
      authority.actor,
      authority.agent,
      authority.agent.discoveryTags,
      authority.currentPolicy,
      authority.currentPolicy.rules,
      authority.currentPolicy.rules.operations,
      authority.requestContext,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(authority.agent.policy).toBe(authority.currentPolicy);

    sourceTags.push("attacker-controlled");
    sourceActorCreatedAt.setTime(0);
    sourceAgentCreatedAt.setTime(0);
    sourcePolicyEffectiveFrom.setTime(0);
    expect(authority.agent.discoveryTags).toEqual(["semiconductors", "risk"]);
    expect(authority.actor.createdAt).toEqual(createdAt);
    expect(authority.agent.createdAt).toEqual(createdAt);
    expect(authority.currentPolicy.effectiveFrom).toEqual(createdAt);

    for (const returnedDate of [
      authority.actor.createdAt,
      authority.actor.updatedAt,
      authority.agent.createdAt,
      authority.agent.updatedAt,
      authority.agent.activatedAt,
      authority.currentPolicy.effectiveFrom,
      authority.requestContext.authenticatedAt,
      authority.authorityCheckedAt,
    ]) {
      returnedDate.setTime(0);
    }
    expect(authority.actor.createdAt).toEqual(createdAt);
    expect(authority.agent.createdAt).toEqual(createdAt);
    expect(authority.currentPolicy.effectiveFrom).toEqual(createdAt);
    expect(authority.requestContext.authenticatedAt).toEqual(createdAt);
    expect(authority.authorityCheckedAt).toEqual(checkedAt);
  });

  it.each([
    ["missing Owner", []],
    ["inactive Owner", [validOwnerRow({ status: "suspended" })]],
    ["unverified Owner", [validOwnerRow({ email_verified_at: null })]],
    [
      "future verification",
      [validOwnerRow({ email_verified_at: new Date(checkedAt.valueOf() + 1) })],
    ],
    ["deleted Owner", [validOwnerRow({ deleted_at: checkedAt })]],
  ])("denies %s without disclosing a selected Actor", async (_label, ownerRows) => {
    const database = fakePostgres({ ownerRows });
    const error = await expectAuthorityError(
      database,
      ownerDirectSelection(),
      "OWNER_NOT_ELIGIBLE",
    );
    expect(error.statusCode).toBe(403);
    expect(error.message).not.toContain(ownerId);
    expect(
      database.calls.some((call) => call.text.includes("from platform.agents")),
    ).toBe(false);
  });

  it.each([
    ["cross-Owner human", { actor_owner_id: otherOwnerId }],
    ["wrong human kind", { actor_kind: "agent" }],
    ["inactive human", { actor_status: "restricted" }],
    ["deleted human", { actor_status: "archived", actor_deleted_at: checkedAt }],
  ])("fails closed for %s", async (_label, overrides) => {
    const database = fakePostgres({ humanRows: [validHumanRow(overrides)] });
    const error = await expectAuthorityError(
      database,
      humanDirectSelection(),
      "AUTHORITY_NOT_FOUND",
    );
    expect(error.statusCode).toBe(404);
    expect(error.message).not.toContain(humanActorId);
    expect(error.message).not.toContain(otherOwnerId);
  });

  it.each([
    ["cross-Owner Agent", { agent_owner_id: otherOwnerId }],
    ["cross-Owner Actor", { actor_owner_id: otherOwnerId }],
    ["cross-Actor selection", { actor_id: otherActorId }],
    ["broken Agent-Actor chain", { agent_actor_id: otherActorId }],
    ["wrong Agent Actor kind", { actor_kind: "human" }],
    ["inactive Agent", { agent_status: "restricted" }],
    ["inactive Agent Actor", { actor_status: "suspended" }],
    ["deleted Agent", { agent_status: "archived", agent_deleted_at: checkedAt }],
    ["inactive policy", { policy_is_active: false }],
    ["cross-Owner policy", { policy_owner_id: otherOwnerId }],
    ["cross-Agent policy", { policy_agent_id: otherActorId }],
    ["unknown standard rules", { policy_rules: { content_write: "allow" } }],
    ["unknown Custom rules", { policy_tier: "custom", policy_rules: { nope: "allow" } }],
  ])("fails closed for %s", async (_label, overrides) => {
    const database = fakePostgres({ agentRows: [validAgentRow(overrides)] });
    const error = await expectAuthorityError(
      database,
      ownerDirectSelection(),
      "AUTHORITY_NOT_FOUND",
    );
    expect(error.statusCode).toBe(404);
    expect(error.message).not.toContain(agentId);
    expect(error.message).not.toContain(otherOwnerId);
  });

  it("requires one current policy and preserves database availability failures", async () => {
    await expectAuthorityError(
      fakePostgres({ agentRows: [] }),
      ownerDirectSelection(),
      "AUTHORITY_NOT_FOUND",
    );

    const error = await resolveFakeAuthority(
      fakePostgres({ rejectAuthority: true }),
      mutationContext(),
      ownerDirectSelection(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WebSocialAuthorityError);
    expect((error as Error).message).toBe("database unavailable");
  });

  it("does not select or return credential secrets", async () => {
    const database = fakePostgres();
    const agentAuthority = await resolveFakeAuthority(
      database,
      mutationContext(),
      ownerDirectSelection(),
    );
    const humanAuthority = await resolveFakeAuthority(
      database,
      mutationContext(),
      humanDirectSelection(),
    );
    const queryText = database.calls.map((call) => call.text).join("\n");

    expect(queryText).not.toMatch(
      /auth_user_id|secret_digest|token_prefix|password|api_key|oauth_grant/iu,
    );
    expect(JSON.stringify(agentAuthority)).not.toMatch(
      /secret|token|password|auth_user|email|cookie|session_?id/iu,
    );
    expect(JSON.stringify(humanAuthority)).not.toMatch(
      /secret|token|password|auth_user|email|cookie|session_?id/iu,
    );
    expect(humanAuthority).toMatchObject({
      agent: null,
      currentPolicy: null,
      credential: null,
    });
  });
});

describe("evaluateOwnerDirectOperation", () => {
  it.each<
    [
      string,
      AgentPolicyTier,
      AgentOperation,
      AgentPolicyRules["operations"],
      AgentPolicyDecision,
      "allow" | "deny",
      boolean,
      string,
    ]
  >([
    [
      "Read-only content deny",
      "read_only",
      "create_post",
      {},
      "deny",
      "deny",
      false,
      "POLICY_DENIED",
    ],
    [
      "Read-only social deny",
      "read_only",
      "set_reaction",
      {},
      "deny",
      "deny",
      false,
      "POLICY_DENIED",
    ],
    [
      "Assisted explicit click",
      "assisted",
      "create_post",
      {},
      "require_approval",
      "allow",
      true,
      "OWNER_DIRECT_APPROVAL_SATISFIED",
    ],
    [
      "Autonomous allow",
      "autonomous",
      "reply_to_content",
      {},
      "allow",
      "allow",
      false,
      "ALLOWED_BY_POLICY",
    ],
    [
      "Custom explicit deny",
      "custom",
      "create_post",
      { content_write: "deny" },
      "deny",
      "deny",
      false,
      "POLICY_DENIED",
    ],
    [
      "Custom explicit approval",
      "custom",
      "create_post",
      { content_write: "require_approval" },
      "require_approval",
      "allow",
      true,
      "OWNER_DIRECT_APPROVAL_SATISFIED",
    ],
    [
      "Custom explicit allow",
      "custom",
      "create_post",
      { content_write: "allow" },
      "allow",
      "allow",
      false,
      "ALLOWED_BY_POLICY",
    ],
    [
      "Custom inherited Assisted approval",
      "custom",
      "delete_content",
      {},
      "require_approval",
      "allow",
      true,
      "OWNER_DIRECT_APPROVAL_SATISFIED",
    ],
  ])(
    "%s",
    async (
      _label,
      tier,
      operation,
      operations,
      ownerPolicyDecision,
      decision,
      approvalSatisfied,
      reason,
    ) => {
      const authority = await resolvedAuthorityWithPolicy(tier, operations);
      expect(evaluateOwnerDirectOperation(authority, operation)).toEqual({
        approvalSatisfied,
        decision,
        ownerPolicyDecision,
        reason,
      });
    },
  );

  it.each([
    ["unknown defaults", { defaultsVersion: "future-defaults" }, null],
    ["unknown schema", { schemaVersion: 2 }, null],
    ["incomplete rules", {}, { operations: { content_write: "allow" } }],
    ["unknown rule", {}, { operations: { unknown_write: "allow" } }],
  ])("fails closed for %s", async (_label, metadata, invalidRules) => {
    const base = await resolvedAuthorityWithPolicy("assisted", {}, metadata);
    const currentPolicy = {
      ...base.currentPolicy,
      ...(invalidRules ? { rules: invalidRules } : {}),
    } as AgentPolicyView;
    const authority = invalidRules
      ? ({
          ...base,
          currentPolicy,
          agent: { ...base.agent, policy: currentPolicy },
        } as unknown as OwnerDirectAgentAuthority)
      : base;
    expect(evaluateOwnerDirectOperation(authority, "create_post")).toEqual({
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });
  });

  it("rejects manually constructed and cloned authority values", async () => {
    const issued = await resolvedOwnerDirectAuthority();
    const manual = {
      kind: "owner_direct",
    } as unknown as OwnerDirectAgentAuthority;
    const clone = {
      ...issued,
      agent: { ...issued.agent },
      currentPolicy: { ...issued.currentPolicy },
    } as unknown as OwnerDirectAgentAuthority;

    for (const authority of [manual, clone]) {
      expect(evaluateOwnerDirectOperation(authority, "create_post")).toEqual({
        approvalSatisfied: false,
        decision: "deny",
        ownerPolicyDecision: "deny",
        reason: "POLICY_RULES_UNAVAILABLE",
      });
    }
  });

  it("keeps an issued deny immutable when callers attempt policy mutation", async () => {
    const authority = await resolvedAuthorityWithPolicy("custom", {
      content_write: "deny",
    });
    expect(evaluateOwnerDirectOperation(authority, "create_post")).toMatchObject({
      decision: "deny",
      reason: "POLICY_DENIED",
    });

    expect(() => {
      (authority.currentPolicy.rules.operations as Record<string, string>).content_write =
        "allow";
    }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(authority, "currentPolicy", {
        value: {
          ...authority.currentPolicy,
          rules: { operations: { content_write: "allow" } },
        },
      });
    }).toThrow(TypeError);

    expect(evaluateOwnerDirectOperation(authority, "create_post")).toMatchObject({
      decision: "deny",
      reason: "POLICY_DENIED",
    });
  });

  it("fails closed when duplicated authority facts drift", async () => {
    const authority = await resolvedOwnerDirectAuthority();
    const drifted = {
      ...authority,
      principalScopeKey: `owner_direct:${ownerId}:${otherActorId}`,
    } as OwnerDirectAgentAuthority;
    expect(evaluateOwnerDirectOperation(drifted, "create_post")).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });
  });

  it.each([
    ["context Owner", { ownerId: otherOwnerId }],
    ["request channel", { channel: "mcp" }],
    ["CSRF fact", { csrfValidated: false }],
    ["authentication assurance", { authenticationAssurance: "password_only" }],
    [
      "future authentication time",
      { authenticatedAt: new Date(checkedAt.valueOf() + 1) },
    ],
    ["unknown request fact", { token: "must-not-be-trusted" }],
  ])("fails closed when %s drifts", async (_label, override) => {
    const authority = await resolvedOwnerDirectAuthority();
    const drifted = {
      ...authority,
      requestContext: {
        ...authority.requestContext,
        ...override,
      },
    } as unknown as OwnerDirectAgentAuthority;

    expect(evaluateOwnerDirectOperation(drifted, "create_post")).toMatchObject({
      decision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    });
  });
});
