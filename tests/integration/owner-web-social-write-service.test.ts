import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import {
  PostgresAgentConnectionService,
  type AgentPolicyTier,
} from "../../packages/domain/src/agent-connection.js";
import { PostgresFollowService } from "../../packages/domain/src/follow.js";
import { PostgresOwnerSocialIdentityService } from "../../packages/domain/src/owner-social-identity.js";
import {
  createOwnerWebContextAuthority,
  type OwnerWebMutationContext,
} from "../../packages/domain/src/owner-web-session-context.js";
import { PostgresReactionWriteService } from "../../packages/domain/src/reaction-write.js";
import { PostgresResearchWriteService } from "../../packages/domain/src/research-write.js";
import { PostgresWebSocialAuthorityResolver } from "../../packages/domain/src/web-social-authority.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeOwnerWebSocialWrite = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];

const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "owner-web-social-write-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

interface OwnerFixture {
  authenticatedAt: Date;
  ownerId: string;
  sessionId: string;
}

interface AgentFixture {
  actorId: string;
  agentId: string;
  policyVersion: string;
}

function marker(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

describeOwnerWebSocialWrite("Owner Web social research writes", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const contextAuthority = createOwnerWebContextAuthority();
  const identityService = new PostgresOwnerSocialIdentityService(postgres.sql, {
    contextVerifier: contextAuthority.verifier,
  });
  const authorityResolver = new PostgresWebSocialAuthorityResolver(
    postgres.sql,
    contextAuthority.verifier,
  );
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  const researchService = new PostgresResearchWriteService(postgres.sql, {
    agentContentRateLimits: {
      establishedPostsPerHour: 100,
      establishedRepliesPerHour: 100,
      newAgentPostsPerHour: 100,
      newAgentRepliesPerHour: 100,
    },
    pendingActionKeyRing: {
      currentVersion: 1,
      keys: { 1: randomBytes(32) },
    },
    webSocialAuthorityResolver: authorityResolver,
  });
  const reactionService = new PostgresReactionWriteService(postgres.sql, {
    webSocialAuthorityResolver: authorityResolver,
  });
  const followService = new PostgresFollowService(postgres.sql, {
    cursorSigningKey: randomBytes(32),
    webSocialAuthorityResolver: authorityResolver,
  });
  dependencies.push(postgres);

  let communityId = "";
  let owner: OwnerFixture;
  let assistedAgent: AgentFixture;
  let deniedAgent: AgentFixture;
  let humanActorId = "";
  let humanContentId = "";

  function mutationContext(requestId = randomUUID()): OwnerWebMutationContext {
    return contextAuthority.issuer.issueMutationContext({
      authenticatedAt: new Date(owner.authenticatedAt.valueOf()),
      authenticationAssurance: "owner_session",
      ownerId: owner.ownerId,
      requestId,
      sessionId: owner.sessionId,
    });
  }

  async function setPolicyTier(
    ownerId: string,
    agentId: string,
    tier: AgentPolicyTier,
  ): Promise<string> {
    return postgres.sql.begin(async (transaction) => {
      const currentRows = await transaction<
        {
          defaults_version: string;
          policy_schema_version: number;
          version: number;
        }[]
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
      const current = required(currentRows[0], "active Agent policy");
      const version = current.version + 1;
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
          ${version},
          ${transaction.json({})},
          true,
          ${ownerId}
        )
      `;
      return String(version);
    });
  }

  async function createAgent(
    ownerId: string,
    label: string,
    tier: AgentPolicyTier,
  ): Promise<AgentFixture> {
    const suffix = marker();
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: `${label} Web Agent`,
        handle: `web-${label.toLowerCase()}-${suffix}`,
      },
      randomUUID(),
    );
    return {
      actorId: created.agent.actorId,
      agentId: created.agent.id,
      policyVersion: await setPolicyTier(ownerId, created.agent.id, tier),
    };
  }

  beforeAll(async () => {
    const suffix = marker();
    const userRows = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Owner Web Research Writer',
        ${`owner-web-write-${suffix}@private.example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const userId = required(userRows[0]?.id, "Auth User");
    const ownerRows = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = required(ownerRows[0]?.id, "Owner");
    const sessionId = randomUUID();
    const sessionRows = await postgres.sql<{ created_at: Date }[]>`
      with session_time as (
        select clock_timestamp() as created_at
      )
      insert into auth.sessions (
        id,
        expires_at,
        token,
        created_at,
        updated_at,
        user_id
      )
      select
        ${sessionId},
        session_time.created_at + interval '1 hour',
        ${`owner-web-write-session-${randomUUID()}`},
        session_time.created_at,
        session_time.created_at,
        ${userId}
      from session_time
      returning created_at
    `;
    owner = {
      authenticatedAt: required(sessionRows[0]?.created_at, "Owner session"),
      ownerId,
      sessionId,
    };

    const topicId = randomUUID();
    communityId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values (
          ${topicId},
          ${`owner-web-write-${suffix}`},
          'Owner Web write integration',
          'Isolated topic for Owner Web social write coverage.'
        )
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
        values (
          ${communityId},
          ${`owner-web-write-${suffix}`},
          'Owner Web write integration',
          'Isolated Community for Owner Web social write coverage.',
          'topic',
          ${transaction.json({
            allowed_content: ["investment-research", "discussion"],
            max_posts_per_hour: 20,
            replies_open: true,
            requires_sources: false,
          })},
          ${transaction.json({ integration_fixture: suffix })}
        )
      `;
      await transaction`
        insert into platform.community_topics (community_id, topic_id, is_primary)
        values (${communityId}, ${topicId}, true)
      `;
    });

    assistedAgent = await createAgent(ownerId, "Assisted", "assisted");
    deniedAgent = await createAgent(ownerId, "Denied", "read_only");
    const human = await identityService.enableHumanProfile(mutationContext(), {
      displayName: "Owner Web Human",
      handle: `owner-web-human-${suffix}`,
    });
    humanActorId = human.profile.actorId;
    const humanContent = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      { actorId: humanActorId, kind: "human_direct" },
      {
        bodyMarkdown:
          "Stable Human-authored target for Owner Web social interaction coverage.",
        idempotencyKey: `owner-web-human-target-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Owner Web Human interaction target",
      },
    );
    humanContentId = required(
      humanContent.result?.contentId,
      "Owner Web Human interaction target",
    );
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("publishes an assisted Agent post immediately and replays by Owner identity", async () => {
    const idempotencyKey = `owner-web-agent-${randomUUID()}`;
    const input = {
      bodyMarkdown:
        "Owner-reviewed semiconductor demand notes for independent community verification.",
      idempotencyKey,
      primaryCommunityId: communityId,
      symbols: ["MU", "AMD"],
      title: "Owner-reviewed semiconductor demand notes",
    };
    const selection = {
      agentId: assistedAgent.agentId,
      kind: "owner_direct" as const,
    };

    const first = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );
    const replay = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(first).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: false,
      status: "succeeded",
    });
    expect(replay).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: true,
      status: "succeeded",
    });
    expect(replay.result).toEqual(first.result);

    const contentId = required(first.result?.contentId, "Owner Web Agent post");
    const facts = await postgres.sql<
      {
        action_count: number;
        actor_id: string;
        actor_kind: string;
        agent_id: string | null;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        authentication_assurance: string | null;
        channel: string;
        content_count: number;
        credential_id: string | null;
        outbox_event_id: string | null;
        policy_version: string | null;
        principal_scope_key: string;
      }[]
    >`
      select
        content.author_actor_id::text as actor_id,
        audit.actor_kind,
        audit.agent_id::text as agent_id,
        audit.credential_id::text as credential_id,
        audit.channel,
        audit.approval_method,
        audit.approved_by_owner_id::text as approved_by_owner_id,
        audit.authentication_assurance,
        audit.policy_version,
        audit.outbox_event_id::text as outbox_event_id,
        idempotency.principal_scope_key,
        (
          select count(*)::integer
          from platform.content_items as counted
          where counted.id = ${contentId}
        ) as content_count,
        (
          select count(*)::integer
          from platform.action_logs as counted
          where counted.target_type = 'content'
            and counted.target_id = ${contentId}
        ) as action_count
      from platform.content_items as content
      join platform.action_logs as audit
        on audit.target_type = 'content'
       and audit.target_id = content.id::text
      join platform.idempotency_records as idempotency
        on idempotency.resource_id = content.id
       and idempotency.operation = 'create_post'
       and idempotency.idempotency_key = ${idempotencyKey}
      where content.id = ${contentId}
    `;
    expect(facts).toEqual([
      {
        action_count: 1,
        actor_id: assistedAgent.actorId,
        actor_kind: "agent",
        agent_id: assistedAgent.agentId,
        approval_method: "owner_direct",
        approved_by_owner_id: owner.ownerId,
        authentication_assurance: "owner_session",
        channel: "web",
        content_count: 1,
        credential_id: null,
        outbox_event_id: expect.any(String),
        policy_version: assistedAgent.policyVersion,
        principal_scope_key: `owner_direct:${owner.ownerId}:${assistedAgent.agentId}`,
      },
    ]);
  });

  it("publishes a path-targeted human reply with no Agent or policy attribution", async () => {
    const root = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      {
        agentId: assistedAgent.agentId,
        kind: "owner_direct",
      },
      {
        bodyMarkdown: "Root research question for a human follow-up.",
        idempotencyKey: `owner-web-root-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Human follow-up research thread",
      },
    );
    const rootId = required(root.result?.contentId, "Owner Web root post");
    const idempotencyKey = `owner-web-human-${randomUUID()}`;

    const reply = await researchService.replyToContentAsOwnerWeb(
      mutationContext(),
      {
        actorId: humanActorId,
        kind: "human_direct",
      },
      {
        bodyMarkdown:
          "Human follow-up: verify the cited demand signal against the issuer filing.",
        idempotencyKey,
        parentContentId: rootId,
      },
    );

    expect(reply).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: false,
      status: "succeeded",
    });
    const replyId = required(reply.result?.contentId, "human reply");
    const rows = await postgres.sql<
      {
        actor_id: string;
        actor_kind: string;
        agent_id: string | null;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        credential_id: string | null;
        parent_id: string | null;
        policy_version: string | null;
        principal_scope_key: string;
        root_id: string;
      }[]
    >`
      select
        content.author_actor_id::text as actor_id,
        content.parent_id::text as parent_id,
        content.root_id::text as root_id,
        audit.actor_kind,
        audit.agent_id::text as agent_id,
        audit.credential_id::text as credential_id,
        audit.approval_method,
        audit.approved_by_owner_id::text as approved_by_owner_id,
        audit.policy_version,
        idempotency.principal_scope_key
      from platform.content_items as content
      join platform.action_logs as audit
        on audit.target_type = 'content'
       and audit.target_id = content.id::text
      join platform.idempotency_records as idempotency
        on idempotency.resource_id = content.id
       and idempotency.operation = 'reply_to_content'
       and idempotency.idempotency_key = ${idempotencyKey}
      where content.id = ${replyId}
    `;
    expect(rows).toEqual([
      {
        actor_id: humanActorId,
        actor_kind: "human",
        agent_id: null,
        approval_method: "human_direct",
        approved_by_owner_id: owner.ownerId,
        credential_id: null,
        parent_id: rootId,
        policy_version: null,
        principal_scope_key: `human_web:${owner.ownerId}:${humanActorId}`,
        root_id: rootId,
      },
    ]);
  });

  it("updates Human-authored content immediately and replays the same revision result", async () => {
    const idempotencyKey = `owner-web-human-update-${randomUUID()}`;
    const requestId = randomUUID();
    const input = {
      contentId: humanContentId,
      editSummary: "Added the independent-verification requirement.",
      expectedVersion: 1,
      idempotencyKey,
      patch: {
        bodyMarkdown:
          "Revised Human-authored target with an explicit independent-verification requirement.",
      },
    };
    const selection = {
      actorId: humanActorId,
      kind: "human_direct" as const,
    };

    const first = await researchService.updateContentAsOwnerWeb(
      mutationContext(requestId),
      selection,
      input,
    );
    const replay = await researchService.updateContentAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(first).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: false,
      result: {
        contentId: humanContentId,
        resourceVersion: 2,
        revisionId: expect.any(String),
      },
      status: "succeeded",
    });
    expect(replay).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: true,
      result: first.result,
      status: "succeeded",
    });

    const rows = await postgres.sql<
      {
        action_count: number;
        actor_kind: string;
        agent_id: string | null;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        body_markdown: string;
        credential_id: string | null;
        idempotency_status: string;
        policy_version: string | null;
        principal_scope_key: string;
        revision_count: number;
        version: number;
      }[]
    >`
      select
        content.version::integer as version,
        revision.body_markdown,
        audit.actor_kind,
        audit.agent_id::text as agent_id,
        audit.credential_id::text as credential_id,
        audit.approval_method,
        audit.approved_by_owner_id::text as approved_by_owner_id,
        audit.policy_version,
        idempotency.status as idempotency_status,
        idempotency.principal_scope_key,
        (
          select count(*)::integer
          from platform.content_revisions as counted
          where counted.content_id = content.id
        ) as revision_count,
        (
          select count(*)::integer
          from platform.action_logs as counted
          where counted.request_id = ${requestId}
            and counted.action = 'content.update_content'
        ) as action_count
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
      join platform.action_logs as audit
        on audit.request_id = ${requestId}
       and audit.action = 'content.update_content'
      join platform.idempotency_records as idempotency
        on idempotency.operation = 'update_content'
       and idempotency.idempotency_key = ${idempotencyKey}
       and idempotency.actor_id = content.author_actor_id
      where content.id = ${humanContentId}
    `;
    expect(rows).toEqual([
      {
        action_count: 1,
        actor_kind: "human",
        agent_id: null,
        approval_method: "human_direct",
        approved_by_owner_id: owner.ownerId,
        body_markdown:
          "Revised Human-authored target with an explicit independent-verification requirement.",
        credential_id: null,
        idempotency_status: "succeeded",
        policy_version: null,
        principal_scope_key: `human_web:${owner.ownerId}:${humanActorId}`,
        revision_count: 2,
        version: 2,
      },
    ]);
  });

  it("soft-deletes Agent-authored content with the Owner click satisfying approval", async () => {
    const created = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      { agentId: assistedAgent.agentId, kind: "owner_direct" },
      {
        bodyMarkdown: "Temporary Agent research that its author will retract.",
        idempotencyKey: `owner-web-delete-target-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Owner Web delete target",
      },
    );
    const contentId = required(created.result?.contentId, "Owner Web delete target");
    const idempotencyKey = `owner-web-agent-delete-${randomUUID()}`;
    const requestId = randomUUID();
    const input = {
      contentId,
      expectedVersion: 1,
      idempotencyKey,
      mode: "soft" as const,
      reason: "The author retracted the research after finding stale source data.",
    };
    const selection = {
      agentId: assistedAgent.agentId,
      kind: "owner_direct" as const,
    };

    const first = await researchService.deleteContentAsOwnerWeb(
      mutationContext(requestId),
      selection,
      input,
    );
    const replay = await researchService.deleteContentAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(first).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: false,
      result: {
        contentId,
        lifecycleState: "deleted",
        resourceVersion: 2,
      },
      status: "succeeded",
    });
    expect(replay).toMatchObject({
      decision: "allow",
      error: null,
      pendingAction: null,
      replayed: true,
      result: first.result,
      status: "succeeded",
    });

    const rows = await postgres.sql<
      {
        action_count: number;
        approval_method: string | null;
        credential_id: string | null;
        decision: string | null;
        lifecycle_state: string;
        outcome: string;
        owner_policy_decision: string | null;
        version: number;
      }[]
    >`
      select
        content.lifecycle_state,
        content.version::integer as version,
        audit.credential_id::text as credential_id,
        audit.approval_method,
        audit.decision,
        audit.outcome,
        audit.authorization_snapshot ->> 'owner_policy_decision'
          as owner_policy_decision,
        (
          select count(*)::integer
          from platform.action_logs as counted
          where counted.request_id = ${requestId}
            and counted.action = 'content.delete_content'
        ) as action_count
      from platform.content_items as content
      join platform.action_logs as audit
        on audit.request_id = ${requestId}
       and audit.action = 'content.delete_content'
      where content.id = ${contentId}
    `;
    expect(rows).toEqual([
      {
        action_count: 1,
        approval_method: "owner_direct",
        credential_id: null,
        decision: "allow",
        lifecycle_state: "deleted",
        outcome: "succeeded",
        owner_policy_decision: "require_approval",
        version: 2,
      },
    ]);
  });

  it("rejects a content edit when the selected identity is not the author", async () => {
    const created = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      { agentId: assistedAgent.agentId, kind: "owner_direct" },
      {
        bodyMarkdown: "Agent-owned content must remain bound to its public author.",
        idempotencyKey: `owner-web-author-target-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Author boundary target",
      },
    );
    const contentId = required(created.result?.contentId, "author boundary target");

    const outcome = await researchService.updateContentAsOwnerWeb(
      mutationContext(),
      { actorId: humanActorId, kind: "human_direct" },
      {
        contentId,
        expectedVersion: 1,
        idempotencyKey: `owner-web-foreign-author-${randomUUID()}`,
        patch: { bodyMarkdown: "A Human identity must not overwrite Agent content." },
      },
    );

    expect(outcome).toMatchObject({
      decision: "allow",
      error: { code: "NOT_CONTENT_AUTHOR" },
      operation: "update_content",
      pendingAction: null,
      replayed: false,
      result: null,
      status: "failed",
    });
    const rows = await postgres.sql<{ body_markdown: string; version: number }[]>`
      select
        content.version::integer as version,
        revision.body_markdown
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
      where content.id = ${contentId}
    `;
    expect(rows).toEqual([
      {
        body_markdown: "Agent-owned content must remain bound to its public author.",
        version: 1,
      },
    ]);
  });

  it("persists an explicit policy denial without content or PendingAction", async () => {
    const idempotencyKey = `owner-web-denied-${randomUUID()}`;
    const input = {
      bodyMarkdown: "This content must not be published by a read-only Agent.",
      idempotencyKey,
      primaryCommunityId: communityId,
      title: "Read-only Agent denial",
    };
    const selection = {
      agentId: deniedAgent.agentId,
      kind: "owner_direct" as const,
    };

    const requestId = randomUUID();
    const denied = await researchService.createPostAsOwnerWeb(
      mutationContext(requestId),
      selection,
      input,
    );
    const replay = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(denied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED" },
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    });
    expect(replay).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED" },
      pendingAction: null,
      replayed: true,
      result: null,
      status: "denied",
    });
    const rows = await postgres.sql<
      {
        action_count: number;
        content_count: number;
        decision: string | null;
        outcome: string;
        policy_version: string | null;
        status: string;
      }[]
    >`
      select
        idempotency.status,
        (
          select audit.decision
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'content.create_post'
        ) as decision,
        (
          select audit.outcome
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'content.create_post'
        ) as outcome,
        (
          select audit.policy_version
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'content.create_post'
        ) as policy_version,
        (
          select count(*)::integer
          from platform.content_items as content
          where content.author_actor_id = ${deniedAgent.actorId}
            and content.primary_community_id = ${communityId}
        ) as content_count,
        (
          select count(*)::integer
          from platform.action_logs as counted
          where counted.request_id = ${requestId}
            and counted.action = 'content.create_post'
        ) as action_count
      from platform.idempotency_records as idempotency
      where idempotency.principal_scope_key =
            ${`owner_direct:${owner.ownerId}:${deniedAgent.agentId}`}
        and idempotency.operation = 'create_post'
        and idempotency.idempotency_key = ${idempotencyKey}
    `;
    expect(rows).toEqual([
      {
        action_count: 1,
        content_count: 0,
        decision: "deny",
        outcome: "denied",
        policy_version: deniedAgent.policyVersion,
        status: "denied",
      },
    ]);
  });

  it("persists and idempotently replays a Human reaction with Web audit authority", async () => {
    const targetAgent = await createAgent(owner.ownerId, "ReactionTarget", "assisted");
    const target = await researchService.createPostAsOwnerWeb(
      mutationContext(),
      { agentId: targetAgent.agentId, kind: "owner_direct" },
      {
        bodyMarkdown: "Research target for an explicitly selected Human reaction.",
        idempotencyKey: `owner-web-reaction-target-${randomUUID()}`,
        primaryCommunityId: communityId,
        title: "Human reaction integration target",
      },
    );
    const targetId = required(target.result?.contentId, "reaction target");
    const idempotencyKey = `owner-web-human-reaction-${randomUUID()}`;
    const requestId = randomUUID();
    const selection = {
      actorId: humanActorId,
      kind: "human_direct" as const,
    };
    const input = {
      active: true,
      contentId: targetId,
      idempotencyKey,
      reaction: "helpful" as const,
    };

    const first = await reactionService.setReactionAsOwnerWeb(
      mutationContext(requestId),
      selection,
      input,
    );
    const replay = await reactionService.setReactionAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(first).toMatchObject({
      decision: "allow",
      error: null,
      replayed: false,
      result: {
        contentId: targetId,
        reactionCounts: { helpful: 1 },
        viewerState: { reactions: ["helpful"] },
      },
      status: "succeeded",
    });
    expect(replay).toMatchObject({
      decision: "allow",
      error: null,
      replayed: true,
      result: { contentId: targetId },
      status: "succeeded",
    });

    const rows = await postgres.sql<
      {
        actor_id: string;
        actor_kind: string;
        agent_id: string | null;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        authentication_assurance: string | null;
        channel: string;
        credential_id: string | null;
        idempotency_status: string;
        principal_scope_key: string;
        reaction_count: number;
      }[]
    >`
      select
        audit.actor_id::text as actor_id,
        audit.actor_kind,
        audit.agent_id::text as agent_id,
        audit.credential_id::text as credential_id,
        audit.channel,
        audit.approval_method,
        audit.approved_by_owner_id::text as approved_by_owner_id,
        audit.authentication_assurance,
        idempotency.status as idempotency_status,
        idempotency.principal_scope_key,
        (
          select count(*)::integer
          from platform.reactions as reaction
          where reaction.actor_id = ${humanActorId}
            and reaction.content_id = ${targetId}
            and reaction.reaction_type = 'helpful'
        ) as reaction_count
      from platform.action_logs as audit
      join platform.idempotency_records as idempotency
        on idempotency.operation = 'set_reaction'
       and idempotency.idempotency_key = ${idempotencyKey}
       and idempotency.actor_id = audit.actor_id
      where audit.request_id = ${requestId}
        and audit.action = 'reaction.set'
    `;
    expect(rows).toEqual([
      {
        actor_id: humanActorId,
        actor_kind: "human",
        agent_id: null,
        approval_method: "human_direct",
        approved_by_owner_id: owner.ownerId,
        authentication_assurance: "owner_session",
        channel: "web",
        credential_id: null,
        idempotency_status: "succeeded",
        principal_scope_key: `human_web:${owner.ownerId}:${humanActorId}`,
        reaction_count: 1,
      },
    ]);
  });

  it("persists an Owner-direct Agent reaction denial without a reaction row", async () => {
    const targetId = humanContentId;
    const idempotencyKey = `owner-web-denied-reaction-${randomUUID()}`;
    const requestId = randomUUID();

    const denied = await reactionService.setReactionAsOwnerWeb(
      mutationContext(requestId),
      { agentId: deniedAgent.agentId, kind: "owner_direct" },
      {
        active: true,
        contentId: targetId,
        idempotencyKey,
        reaction: "agree",
      },
    );

    expect(denied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED" },
      replayed: false,
      result: null,
      status: "denied",
    });
    const rows = await postgres.sql<
      {
        action_count: number;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        policy_version: string | null;
        reaction_count: number;
        status: string;
      }[]
    >`
      select
        idempotency.status,
        (
          select audit.approval_method
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'reaction.set'
        ) as approval_method,
        (
          select audit.approved_by_owner_id::text
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'reaction.set'
        ) as approved_by_owner_id,
        (
          select audit.policy_version
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'reaction.set'
        ) as policy_version,
        (
          select count(*)::integer
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'reaction.set'
        ) as action_count,
        (
          select count(*)::integer
          from platform.reactions as reaction
          where reaction.actor_id = ${deniedAgent.actorId}
            and reaction.content_id = ${targetId}
        ) as reaction_count
      from platform.idempotency_records as idempotency
      where idempotency.principal_scope_key =
            ${`owner_direct:${owner.ownerId}:${deniedAgent.agentId}`}
        and idempotency.operation = 'set_reaction'
        and idempotency.idempotency_key = ${idempotencyKey}
    `;
    expect(rows).toEqual([
      {
        action_count: 1,
        approval_method: "owner_direct",
        approved_by_owner_id: owner.ownerId,
        policy_version: deniedAgent.policyVersion,
        reaction_count: 0,
        status: "denied",
      },
    ]);
  });

  it("persists and idempotently replays a Human content Follow with Web audit authority", async () => {
    const targetId = humanContentId;
    const idempotencyKey = `owner-web-human-follow-${randomUUID()}`;
    const requestId = randomUUID();
    const selection = {
      actorId: humanActorId,
      kind: "human_direct" as const,
    };
    const input = {
      active: true,
      idempotencyKey,
      notificationLevel: "new_posts" as const,
      targetId,
      targetType: "content" as const,
    };

    const first = await followService.setFollowAsOwnerWeb(
      mutationContext(requestId),
      selection,
      input,
    );
    const replay = await followService.setFollowAsOwnerWeb(
      mutationContext(),
      selection,
      input,
    );

    expect(first).toMatchObject({
      decision: "allow",
      error: null,
      replayed: false,
      result: {
        active: true,
        notificationLevel: "new_posts",
        targetId,
        targetType: "content",
      },
      status: "succeeded",
    });
    expect(replay).toMatchObject({
      decision: "allow",
      error: null,
      replayed: true,
      result: { targetId, targetType: "content" },
      status: "succeeded",
    });

    const rows = await postgres.sql<
      {
        actor_id: string;
        actor_kind: string;
        agent_id: string | null;
        approval_method: string | null;
        approved_by_owner_id: string | null;
        channel: string;
        credential_id: string | null;
        follow_count: number;
        notification_level: string | null;
        principal_scope_key: string;
        status: string;
      }[]
    >`
      select
        audit.actor_id::text as actor_id,
        audit.actor_kind,
        audit.agent_id::text as agent_id,
        audit.credential_id::text as credential_id,
        audit.channel,
        audit.approval_method,
        audit.approved_by_owner_id::text as approved_by_owner_id,
        idempotency.principal_scope_key,
        idempotency.status,
        (
          select count(*)::integer
          from platform.follows as follow
          where follow.follower_actor_id = ${humanActorId}
            and follow.target_type = 'content'
            and follow.target_content_id = ${targetId}
        ) as follow_count,
        (
          select follow.notification_level
          from platform.follows as follow
          where follow.follower_actor_id = ${humanActorId}
            and follow.target_type = 'content'
            and follow.target_content_id = ${targetId}
        ) as notification_level
      from platform.action_logs as audit
      join platform.idempotency_records as idempotency
        on idempotency.operation = 'set_follow'
       and idempotency.idempotency_key = ${idempotencyKey}
       and idempotency.actor_id = audit.actor_id
      where audit.request_id = ${requestId}
        and audit.action = 'follow.set'
    `;
    expect(rows).toEqual([
      {
        actor_id: humanActorId,
        actor_kind: "human",
        agent_id: null,
        approval_method: "human_direct",
        approved_by_owner_id: owner.ownerId,
        channel: "web",
        credential_id: null,
        follow_count: 1,
        notification_level: "new_posts",
        principal_scope_key: `human_web:${owner.ownerId}:${humanActorId}`,
        status: "succeeded",
      },
    ]);
  });

  it("persists an Owner-direct Agent Follow denial without a relationship", async () => {
    const idempotencyKey = `owner-web-denied-follow-${randomUUID()}`;
    const requestId = randomUUID();
    const denied = await followService.setFollowAsOwnerWeb(
      mutationContext(requestId),
      { agentId: deniedAgent.agentId, kind: "owner_direct" },
      {
        active: true,
        idempotencyKey,
        targetId: humanActorId,
        targetType: "actor",
      },
    );

    expect(denied).toMatchObject({
      decision: "deny",
      error: { code: "POLICY_DENIED" },
      replayed: false,
      result: null,
      status: "denied",
    });
    const rows = await postgres.sql<
      {
        action_count: number;
        approval_method: string | null;
        follow_count: number;
        policy_version: string | null;
        status: string;
      }[]
    >`
      select
        idempotency.status,
        (
          select audit.approval_method
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'follow.set'
        ) as approval_method,
        (
          select audit.policy_version
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'follow.set'
        ) as policy_version,
        (
          select count(*)::integer
          from platform.action_logs as audit
          where audit.request_id = ${requestId}
            and audit.action = 'follow.set'
        ) as action_count,
        (
          select count(*)::integer
          from platform.follows as follow
          where follow.follower_actor_id = ${deniedAgent.actorId}
            and follow.target_type = 'actor'
            and follow.target_actor_id = ${humanActorId}
        ) as follow_count
      from platform.idempotency_records as idempotency
      where idempotency.principal_scope_key =
            ${`owner_direct:${owner.ownerId}:${deniedAgent.agentId}`}
        and idempotency.operation = 'set_follow'
        and idempotency.idempotency_key = ${idempotencyKey}
    `;
    expect(rows).toEqual([
      {
        action_count: 1,
        approval_method: "owner_direct",
        follow_count: 0,
        policy_version: deniedAgent.policyVersion,
        status: "denied",
      },
    ]);
  });

  it("rejects a foreign Owner's Agent before creating any write facts", async () => {
    const foreignUserRows = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Foreign Owner Web Writer',
        ${`foreign-owner-web-${marker()}@private.example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const foreignUserId = required(foreignUserRows[0]?.id, "foreign Auth User");
    const foreignOwnerRows = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${foreignUserId}
    `;
    const foreignOwnerId = required(foreignOwnerRows[0]?.id, "foreign Owner");
    const foreignAgent = await createAgent(foreignOwnerId, "Foreign", "assisted");
    const idempotencyKey = `owner-web-foreign-${randomUUID()}`;

    await expect(
      researchService.createPostAsOwnerWeb(
        mutationContext(),
        { agentId: foreignAgent.agentId, kind: "owner_direct" },
        {
          bodyMarkdown: "A foreign Owner must not publish through this Agent.",
          idempotencyKey,
          primaryCommunityId: communityId,
          title: "Foreign authority rejection",
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_NOT_FOUND" });

    const writeFacts = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.idempotency_records
      where idempotency_key = ${idempotencyKey}
    `;
    expect(writeFacts).toEqual([{ count: 0 }]);
  });
});
