import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAgentConnectionService } from "../../packages/domain/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeCommunitySchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "community-schema-key-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describeCommunitySchema("community research core schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  dependencies.push(postgres);

  let ownerId = "";
  let agentId = "";
  let actorId = "";
  let credentialId = "";
  let siblingAgentId = "";
  let siblingActorId = "";
  let siblingCredentialId = "";
  let policyId = "";
  let policyVersion = "";
  let primaryCommunityId = "";
  let additionalCommunityOneId = "";
  let additionalCommunityTwoId = "";
  let rootContentId = "";
  let rootRevisionId = "";

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const authUsers = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'Community Schema Owner',
        ${`community-schema-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const authUserId = authUsers[0]?.id;
    if (!authUserId) {
      throw new Error("Owner Auth User was not inserted");
    }

    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    ownerId = owners[0]?.id ?? "";
    if (!ownerId) {
      throw new Error("Owner projection was not created");
    }

    const created = await agentService.createAgent(
      ownerId,
      {
        handle: `schema-${marker}`,
        displayName: "Community Schema Agent",
      },
      randomUUID(),
    );
    agentId = created.agent.id;
    actorId = created.agent.actorId;
    policyId = created.agent.policy.id;
    policyVersion = created.agent.policy.version;

    const credential = await agentService.createCredential(
      ownerId,
      agentId,
      {
        name: "Community schema test",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    credentialId = credential.credential.id;

    const sibling = await agentService.createAgent(
      ownerId,
      {
        handle: `sibling-${marker}`,
        displayName: "Sibling Schema Agent",
      },
      randomUUID(),
    );
    siblingAgentId = sibling.agent.id;
    siblingActorId = sibling.agent.actorId;
    const siblingCredential = await agentService.createCredential(
      ownerId,
      siblingAgentId,
      {
        name: "Sibling schema test",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    siblingCredentialId = siblingCredential.credential.id;

    primaryCommunityId = randomUUID();
    additionalCommunityOneId = randomUUID();
    additionalCommunityTwoId = randomUUID();
    const topicIds: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.topics (id, slug, name, description)
        values
          (
            ${topicIds[0]},
            ${`semiconductors-${marker}`},
            'Semiconductors',
            'Semiconductor company and supply-chain research.'
          ),
          (
            ${topicIds[1]},
            ${`earnings-${marker}`},
            'Earnings',
            'Company filings and earnings research.'
          ),
          (
            ${topicIds[2]},
            ${`supply-chain-${marker}`},
            'Supply Chain',
            'Channel and supply-chain research.'
          )
      `;
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind
        )
        values
          (
            ${primaryCommunityId},
            ${`semiconductors-${marker}`},
            'Semiconductors',
            'Semiconductor research.',
            'topic'
          ),
          (
            ${additionalCommunityOneId},
            ${`earnings-${marker}`},
            'Earnings',
            'Earnings research.',
            'topic'
          ),
          (
            ${additionalCommunityTwoId},
            ${`supply-chain-${marker}`},
            'Supply Chain',
            'Supply-chain research.',
            'topic'
          )
      `;
      await transaction`
        insert into platform.community_topics (
          community_id,
          topic_id,
          is_primary
        )
        values
          (${primaryCommunityId}, ${topicIds[0]}, true),
          (${additionalCommunityOneId}, ${topicIds[1]}, true),
          (${additionalCommunityTwoId}, ${topicIds[2]}, true)
      `;
    });
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  async function createContent(options: {
    body?: string;
    depth?: number;
    kind?: "post" | "reply";
    parentId?: string;
    primaryCommunity?: string;
    rootId?: string;
    title?: string | null;
  }): Promise<{ contentId: string; revisionId: string }> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const kind = options.kind ?? "post";
    const body = options.body ?? "A canonical research body.";
    const title = options.title === undefined ? "Canonical research post" : options.title;
    const rootId = kind === "post" ? contentId : (options.rootId ?? "");
    const depth = kind === "post" ? 0 : (options.depth ?? 1);

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          primary_community_id,
          root_id,
          parent_id,
          depth
        )
        values (
          ${contentId},
          ${kind},
          ${actorId},
          ${kind === "post" ? (options.primaryCommunity ?? primaryCommunityId) : null},
          ${rootId},
          ${kind === "reply" ? (options.parentId ?? null) : null},
          ${depth}
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
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        values (
          ${revisionId},
          ${contentId},
          1,
          ${kind === "post" ? title : null},
          ${body},
          ${body.replaceAll(/[*_`#<>]/g, "") || "untrusted content"},
          ${actorId},
          1,
          ${randomBytes(32)},
          1024
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
      `;
    });

    return { contentId, revisionId };
  }

  it("records the exact 000006 migration checksum", async () => {
    const migrationBytes = await readFile(
      `${process.cwd()}/db/migrations/000006_community_research_core.up.sql`,
    );
    const expectedChecksum = createHash("sha256").update(migrationBytes).digest("hex");
    const rows = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000006'
    `;

    expect(rows).toEqual([
      {
        version: "000006",
        name: "community_research_core",
        checksum: expectedChecksum,
      },
    ]);
  });

  it("supports community discovery and atomically materializes one symbol community", async () => {
    const symbolId = randomUUID();
    const candidateCommunityId = randomUUID();
    const ticker = `Z${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await postgres.sql`
      insert into platform.symbols (
        id,
        community_candidate_id,
        ticker,
        exchange,
        name
      )
      values (
        ${symbolId},
        ${candidateCommunityId},
        ${ticker},
        'NASDAQ',
        'Schema Test Symbol'
      )
    `;

    const catalogOnly = await postgres.sql<
      { id: string; materialized: boolean; ticker: string }[]
    >`
      select
        symbol.community_candidate_id as id,
        community.id is not null as materialized,
        symbol.ticker::text as ticker
      from platform.symbols as symbol
      left join platform.communities as community
        on community.id = symbol.community_candidate_id
      where symbol.id = ${symbolId}
    `;
    expect(catalogOnly).toEqual([
      {
        id: candidateCommunityId,
        materialized: false,
        ticker,
      },
    ]);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        postgres.sql.begin(async (transaction) => {
          await transaction`
            insert into platform.communities (
              id,
              slug,
              name,
              description,
              kind
            )
            values (
              ${candidateCommunityId},
              ${`stock-${ticker.toLowerCase()}`},
              ${`${ticker} Research`},
              'A deterministically selected catalog symbol destination.',
              'symbol'
            )
          `;
          await transaction`
            insert into platform.community_symbols (
              community_id,
              symbol_id,
              is_primary
            )
            values (${candidateCommunityId}, ${symbolId}, true)
          `;
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(11);

    const materialized = await postgres.sql<
      { community_id: string; symbol_id: string }[]
    >`
      select mapping.community_id, mapping.symbol_id
      from platform.community_symbols as mapping
      where mapping.symbol_id = ${symbolId}
    `;
    expect(materialized).toHaveLength(1);
    const materializedCommunityId = materialized[0]?.community_id;
    if (!materializedCommunityId) {
      throw new Error("Symbol Community was not materialized");
    }

    const discovered = await postgres.sql<{ id: string; kind: string }[]>`
      select community.id, community.kind
      from platform.communities as community
      where community.deleted_at is null
        and community.status = 'active'
        and (
          community.name ilike ${`%${ticker}%`}
          or community.slug::text ilike ${`%${ticker.toLowerCase()}%`}
        )
    `;
    expect(discovered).toEqual([
      {
        id: candidateCommunityId,
        kind: "symbol",
      },
    ]);

    await expect(
      postgres.sql`
        update platform.community_symbols
        set symbol_id = ${randomUUID()}
        where community_id = ${materializedCommunityId}
      `,
    ).rejects.toThrow();
  });

  it("enforces complete posting defaults and permits audited domain denials without Outbox", async () => {
    const communities = await postgres.sql<
      {
        allowed_content: unknown;
        max_posts_per_hour: number;
        replies_open: boolean;
        requires_sources: boolean;
      }[]
    >`
      select
        posting_rules->'allowed_content' as allowed_content,
        (posting_rules->>'max_posts_per_hour')::integer as max_posts_per_hour,
        (posting_rules->>'replies_open')::boolean as replies_open,
        (posting_rules->>'requires_sources')::boolean as requires_sources
      from platform.communities
      where id = ${primaryCommunityId}
    `;
    expect(communities).toEqual([
      {
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
    ]);

    await expect(
      postgres.sql`
        update platform.communities
        set version = version + 1,
            posting_rules = '{}'::jsonb
        where id = ${primaryCommunityId}
      `,
    ).rejects.toThrow();

    const requestId = `schema-deny-${randomUUID()}`;
    await expect(
      postgres.sql`
        insert into platform.action_logs (
          event_class,
          actor_id,
          actor_kind,
          owner_id,
          agent_id,
          credential_id,
          channel,
          approval_method,
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          error_code,
          policy_version,
          request_id,
          reason_code
        )
        values (
          'domain_write',
          ${actorId},
          'agent',
          ${ownerId},
          ${agentId},
          ${credentialId},
          'rest',
          'policy_auto',
          'static_api_key',
          '{"policy_evaluated":true}'::jsonb,
          'content.create',
          'community',
          ${primaryCommunityId},
          'deny',
          'denied',
          'POLICY_DENIED',
          ${policyVersion},
          ${requestId},
          'policy_denied'
        )
      `,
    ).resolves.toBeDefined();

    const logs = await postgres.sql<
      { outbox_event_id: string | null; outcome: string }[]
    >`
      select outcome, outbox_event_id
      from platform.action_logs
      where request_id = ${requestId}
    `;
    expect(logs).toEqual([{ outcome: "denied", outbox_event_id: null }]);
  });

  it("keeps one canonical post across primary and additional communities", async () => {
    const created = await createContent({
      body: "## MU research\n\nOne canonical body shared by all community views.",
      title: "MU research across three communities",
    });
    rootContentId = created.contentId;
    rootRevisionId = created.revisionId;

    await postgres.sql`
      insert into platform.content_additional_communities (
        content_id,
        community_id,
        position
      )
      values
        (${rootContentId}, ${additionalCommunityOneId}, 1),
        (${rootContentId}, ${additionalCommunityTwoId}, 2)
    `;

    const placements = await postgres.sql<{ content_id: string; placements: number }[]>`
      select placement.content_id, count(*)::integer as placements
      from (
        select content.id as content_id, content.primary_community_id as community_id
        from platform.content_items as content
        where content.id = ${rootContentId}
        union all
        select additional.content_id, additional.community_id
        from platform.content_additional_communities as additional
        where additional.content_id = ${rootContentId}
      ) as placement
      group by placement.content_id
    `;
    expect(placements).toEqual([{ content_id: rootContentId, placements: 3 }]);

    const facts = await postgres.sql<{ content_items: number; revisions: number }[]>`
      select
        (
          select count(*)::integer
          from platform.content_items
          where id = ${rootContentId}
        ) as content_items,
        (
          select count(*)::integer
          from platform.content_revisions
          where content_id = ${rootContentId}
        ) as revisions
    `;
    expect(facts[0]).toEqual({ content_items: 1, revisions: 1 });

    await expect(
      postgres.sql.begin(async (transaction) => {
        const incompleteId = randomUUID();
        await transaction`
          insert into platform.content_items (
            id,
            kind,
            author_actor_id,
            primary_community_id,
            root_id,
            depth
          )
          values (
            ${incompleteId},
            'post',
            ${actorId},
            ${primaryCommunityId},
            ${incompleteId},
            0
          )
        `;
      }),
    ).rejects.toThrow();
  });

  it("preserves exact reply ancestry through depth 100 and rejects depth 101", async () => {
    let parentId = rootContentId;
    for (let depth = 1; depth <= 100; depth += 1) {
      const reply = await createContent({
        body: `Reply at logical depth ${depth}.`,
        depth,
        kind: "reply",
        parentId,
        rootId: rootContentId,
        title: null,
      });
      parentId = reply.contentId;
    }

    const deepest = await postgres.sql<
      { depth: number; parent_id: string; root_id: string }[]
    >`
      select depth, parent_id, root_id
      from platform.content_items
      where id = ${parentId}
    `;
    expect(deepest).toEqual([
      {
        depth: 100,
        parent_id: expect.any(String),
        root_id: rootContentId,
      },
    ]);

    const tooDeepId = randomUUID();
    await expect(
      postgres.sql`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          root_id,
          parent_id,
          depth
        )
        values (
          ${tooDeepId},
          'reply',
          ${actorId},
          ${rootContentId},
          ${parentId},
          101
        )
      `,
    ).rejects.toThrow();
  }, 30_000);

  it("serializes Revision numbers and makes committed revisions append-only", async () => {
    const candidates = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(
      candidates.map((revisionId, index) =>
        postgres.sql.begin(async (transaction) => {
          await transaction`
            insert into platform.content_revisions (
              id,
              content_id,
              revision_number,
              title,
              body_markdown,
              body_plain_text,
              edit_summary,
              created_by_actor_id,
              source_version,
              content_hash,
              public_node_serialized_bytes
            )
            values (
              ${revisionId},
              ${rootContentId},
              2,
              'MU research across three communities',
              ${`Concurrent immutable Revision candidate ${index}.`},
              ${`Concurrent immutable Revision candidate ${index}.`},
              'Concurrency test',
              ${actorId},
              2,
              ${randomBytes(32)},
              1024
            )
          `;
          await transaction`
            update platform.content_items
            set current_revision_id = ${revisionId},
                version = 2
            where id = ${rootContentId}
              and version = 1
          `;
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const current = await postgres.sql<
      { current_revision_id: string; revision_count: number; version: number }[]
    >`
      select
        content.current_revision_id,
        content.version::integer,
        (
          select count(*)::integer
          from platform.content_revisions as revision
          where revision.content_id = content.id
        ) as revision_count
      from platform.content_items as content
      where content.id = ${rootContentId}
    `;
    expect(current[0]).toMatchObject({ revision_count: 2, version: 2 });
    rootRevisionId = current[0]?.current_revision_id ?? "";

    await expect(
      postgres.sql`
        update platform.content_revisions
        set body_markdown = 'overwritten'
        where id = ${rootRevisionId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        delete from platform.content_revisions
        where id = ${rootRevisionId}
      `,
    ).rejects.toThrow();
  });

  it("keeps source, reference, and mention provenance as immutable UGC facts", async () => {
    const target = await createContent({
      body: "A stable reference target.",
      title: "Reference target research",
    });
    const sourceId = randomUUID();
    const relationId = randomUUID();
    const sourceUrl = "https://127.0.0.1/private-research-source";

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          title,
          description,
          added_revision_id,
          added_by_actor_id
        )
        values (
          ${sourceId},
          ${rootContentId},
          1,
          ${sourceUrl},
          ${createHash("sha256").update(sourceUrl).digest()},
          'Author supplied source',
          'Stored as an untrusted string without a server-side fetch.',
          ${rootRevisionId},
          ${actorId}
        )
      `;
      await transaction`
        insert into platform.content_relations (
          id,
          from_content_id,
          to_content_id,
          position,
          relation_type,
          added_revision_id
        )
        values (
          ${relationId},
          ${rootContentId},
          ${target.contentId},
          1,
          'reference',
          ${rootRevisionId}
        )
      `;
      await transaction`
        insert into platform.mentions (
          revision_id,
          content_id,
          revision_number,
          mentioned_actor_id,
          position
        )
        values (
          ${rootRevisionId},
          ${rootContentId},
          2,
          ${siblingActorId},
          1
        )
      `;
    });

    const facts = await postgres.sql<
      {
        description: string;
        mentioned_actor_id: string;
        relation_type: string;
        url: string;
      }[]
    >`
      select
        source.url,
        source.description,
        relation.relation_type,
        mention.mentioned_actor_id
      from platform.source_links as source
      join platform.content_relations as relation
        on relation.from_content_id = source.content_id
      join platform.mentions as mention
        on mention.content_id = source.content_id
      where source.id = ${sourceId}
        and relation.id = ${relationId}
    `;
    expect(facts).toEqual([
      {
        url: sourceUrl,
        description: "Stored as an untrusted string without a server-side fetch.",
        relation_type: "reference",
        mentioned_actor_id: siblingActorId,
      },
    ]);

    await expect(
      postgres.sql`
        update platform.source_links
        set url = 'https://example.test/rewritten'
        where id = ${sourceId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        delete from platform.mentions
        where revision_id = ${rootRevisionId}
          and mentioned_actor_id = ${siblingActorId}
      `,
    ).rejects.toThrow();
  });

  it("scopes idempotency to the authenticated principal under concurrency", async () => {
    const operationKey = `same-command-${randomUUID()}`;
    const principal = `credential:${credentialId}`;
    const digest = randomBytes(32);
    const expiresAt = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

    const outcomes = await Promise.allSettled(
      Array.from(
        { length: 12 },
        () =>
          postgres.sql`
          insert into platform.idempotency_records (
            principal_scope_key,
            owner_id,
            agent_id,
            actor_id,
            credential_id,
            operation,
            idempotency_key,
            request_digest,
            status,
            expires_at
          )
          values (
            ${principal},
            ${ownerId},
            ${agentId},
            ${actorId},
            ${credentialId},
            'create_post',
            ${operationKey},
            ${digest},
            'in_progress',
            ${expiresAt}
          )
        `,
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(11);

    await expect(
      postgres.sql`
        insert into platform.idempotency_records (
          principal_scope_key,
          owner_id,
          agent_id,
          actor_id,
          credential_id,
          operation,
          idempotency_key,
          request_digest,
          status,
          expires_at
        )
        values (
          ${`credential:${siblingCredentialId}`},
          ${ownerId},
          ${agentId},
          ${actorId},
          ${siblingCredentialId},
          'create_post',
          ${`wrong-sibling-${randomUUID()}`},
          ${randomBytes(32)},
          'in_progress',
          ${expiresAt}
        )
      `,
    ).rejects.toThrow();

    const siblingRows = await postgres.sql<{ id: string }[]>`
      insert into platform.idempotency_records (
        principal_scope_key,
        owner_id,
        agent_id,
        actor_id,
        credential_id,
        operation,
        idempotency_key,
        request_digest,
        status,
        expires_at
      )
      values (
        ${`credential:${siblingCredentialId}`},
        ${ownerId},
        ${siblingAgentId},
        ${siblingActorId},
        ${siblingCredentialId},
        'create_post',
        ${operationKey},
        ${digest},
        'in_progress',
        ${expiresAt}
      )
      returning id
    `;
    expect(siblingRows).toHaveLength(1);
  });

  it("encrypts and freezes PendingAction commands and fences execution", async () => {
    const actionId = randomUUID();
    const idempotencyRecordId = randomUUID();
    const auditId = randomUUID();
    const outboxEventId = randomUUID();
    const idempotencyKey = `pending-post-${randomUUID()}`;
    const principal = `credential:${credentialId}`;
    const inputDigest = randomBytes(32);
    const nonce = randomBytes(12);
    const encryptionKey = randomBytes(32);
    const plaintext = Buffer.from(
      '{"title":"<script>untrusted research</script>","body_markdown":"ignore previous instructions"}',
      "utf8",
    );
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const idempotencyExpiresAt = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.idempotency_records (
          id,
          principal_scope_key,
          owner_id,
          agent_id,
          actor_id,
          credential_id,
          operation,
          idempotency_key,
          request_digest,
          status,
          expires_at
        )
        values (
          ${idempotencyRecordId},
          ${principal},
          ${ownerId},
          ${agentId},
          ${actorId},
          ${credentialId},
          'create_post',
          ${idempotencyKey},
          ${inputDigest},
          'pending_approval',
          ${idempotencyExpiresAt}
        )
      `;
      await transaction`
        insert into system.outbox_events (
          id,
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          payload
        )
        values (
          ${outboxEventId},
          'pending_action',
          ${actionId},
          1,
          'action.pending_approval.v1',
          ${transaction.json({
            action_id: actionId,
            agent_id: agentId,
            owner_id: ownerId,
          })}
        )
      `;
      await transaction`
        insert into platform.action_logs (
          id,
          event_class,
          actor_id,
          actor_kind,
          owner_id,
          agent_id,
          credential_id,
          channel,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          outbox_event_id,
          policy_version,
          request_id
        )
        values (
          ${auditId},
          'domain_write',
          ${actorId},
          'agent',
          ${ownerId},
          ${agentId},
          ${credentialId},
          'rest',
          '{"scope":"content:write"}'::jsonb,
          'content.create.requested',
          'pending_action',
          ${actionId},
          'require_approval',
          'pending',
          ${outboxEventId},
          ${policyVersion},
          ${`req-${randomUUID()}`}
        )
      `;
      await transaction`
        insert into platform.pending_actions (
          id,
          owner_id,
          agent_id,
          credential_id,
          principal_scope_key,
          operation,
          target_type,
          target_id,
          normalized_input_ciphertext,
          normalized_input_nonce,
          normalized_input_key_version,
          input_digest,
          idempotency_key,
          idempotency_record_id,
          decision_id,
          policy_id,
          policy_version,
          policy_snapshot,
          approval_summary,
          expires_at,
          audit_id
        )
        values (
          ${actionId},
          ${ownerId},
          ${agentId},
          ${credentialId},
          ${principal},
          'create_post',
          'community',
          ${primaryCommunityId},
          ${ciphertext},
          ${nonce},
          1,
          ${inputDigest},
          ${idempotencyKey},
          ${idempotencyRecordId},
          ${randomUUID()},
          ${policyId},
          ${policyVersion},
          '{"decision":"require_approval","layers":[]}'::jsonb,
          'Create one post in the selected community.',
          ${expiresAt},
          ${auditId}
        )
      `;
    });

    const normalizedColumns = await postgres.sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'platform'
        and table_name = 'pending_actions'
        and column_name like 'normalized_input%'
      order by column_name
    `;
    expect(normalizedColumns.map((column) => column.column_name)).toEqual([
      "normalized_input_ciphertext",
      "normalized_input_format_version",
      "normalized_input_key_version",
      "normalized_input_nonce",
    ]);
    expect(ciphertext.includes(plaintext)).toBe(false);

    await expect(
      postgres.sql`
        update platform.pending_actions
        set normalized_input_ciphertext = ${randomBytes(ciphertext.length)},
            version = 2
        where id = ${actionId}
      `,
    ).rejects.toThrow();

    await postgres.sql`
      update platform.pending_actions
      set state = 'approved',
          version = 2,
          decided_at = clock_timestamp(),
          decided_by_owner_id = ${ownerId},
          approval_method = 'owner_approval'
      where id = ${actionId}
        and state = 'pending_approval'
        and version = 1
    `;

    const executionOutcomes = await Promise.all(
      ["worker-a", "worker-b"].map(async (leaseOwner) => {
        const rows = await postgres.sql<{ id: string }[]>`
          update platform.pending_actions
          set state = 'executing',
              version = 3,
              executing_at = statement_timestamp(),
              lease_owner = ${leaseOwner},
              lease_token_digest = ${randomBytes(32)},
              lease_expires_at = statement_timestamp() + interval '30 seconds',
              last_heartbeat_at = statement_timestamp(),
              attempt_count = 1
          where id = ${actionId}
            and state = 'approved'
            and version = 2
          returning id
        `;
        return rows.length;
      }),
    );
    expect(executionOutcomes.sort()).toEqual([0, 1]);

    const executing = await postgres.sql<
      { attempt_count: number; state: string; version: number }[]
    >`
      select state, version::integer, attempt_count
      from platform.pending_actions
      where id = ${actionId}
    `;
    expect(executing).toEqual([{ state: "executing", version: 3, attempt_count: 1 }]);

    await expect(
      postgres.sql`
        update platform.pending_actions
        set version = 4,
            decided_at = clock_timestamp(),
            last_heartbeat_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + interval '30 seconds'
        where id = ${actionId}
      `,
    ).rejects.toThrow();
  });
});
