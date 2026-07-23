import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
  type PostgresClient,
} from "../../packages/database/src/index.js";
import {
  CONTENT_DELETE_ANTISPAM_MIGRATION_CHECKSUM,
  CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM,
  PostgresAgentConnectionService,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeRevisionSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
type TransactionSql = Parameters<Parameters<PostgresClient["begin"]>[1]>[0];

const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "content-revision-schema-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

interface ApprovedActionFixture {
  actionId: string;
  decisionAuditId: string;
  idempotencyId: string;
  leaseToken: Buffer;
}

function requireId(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

function quoteRole(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error("Unsafe PostgreSQL role fixture name");
  }
  return `"${role}"`;
}

describeRevisionSchema("Content Revision write schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  dependencies.push(postgres);

  let authorActorId = "";
  let alternateActorId = "";
  let primaryCommunityId = "";
  let alternateCommunityId = "";
  let tertiaryCommunityId = "";
  let authorOwnerId = "";
  let primarySymbolId = "";
  let alternateSymbolId = "";
  let primaryTopicId = "";
  let alternateTopicId = "";
  let runtimeRole = "";
  let runtimeActorId = "";
  let runtimeAgentId = "";
  let runtimeCredentialId = "";
  let runtimePolicyId = "";
  let runtimePolicyVersion = "";

  async function asRuntime(
    work: (transaction: TransactionSql) => Promise<void>,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteRole(runtimeRole)}`);
      await transaction.savepoint("runtime_content_bundle", work);
    });
  }

  async function insertInProgressIdempotency(
    transaction: TransactionSql,
    input: {
      id: string;
      key: string;
      operation: "create_post" | "delete_content" | "reply_to_content" | "update_content";
    },
  ): Promise<void> {
    const now = new Date();
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
        first_received_at,
        updated_at,
        expires_at
      )
      values (
        ${input.id},
        ${`credential:${runtimeCredentialId}`},
        ${authorOwnerId},
        ${runtimeAgentId},
        ${runtimeActorId},
        ${runtimeCredentialId},
        ${input.operation},
        ${input.key},
        ${createHash("sha256").update(input.key).digest()},
        'in_progress',
        ${now},
        ${now},
        ${new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1_000)}
      )
    `;
  }

  async function finishContentCommand(
    transaction: TransactionSql,
    input: {
      action:
        | "content.create_post"
        | "content.delete_content"
        | "content.reply_to_content"
        | "content.update_content";
      approvedAction?: ApprovedActionFixture;
      contentId: string;
      eventType:
        "content.deleted" | "content.published" | "content.reply" | "content.revised";
      idempotencyId: string;
      operation: "create_post" | "delete_content" | "reply_to_content" | "update_content";
      payload: Parameters<TransactionSql["json"]>[0];
      resourceVersion: number;
      revisionId: string | null;
      responseCode: 200 | 201;
      fakeApproval?: {
        decisionAuditId: string;
        pendingActionId: string;
      };
    },
  ): Promise<void> {
    const outboxId = randomUUID();
    const sequence = await transaction<{ next_sequence: number }[]>`
      select coalesce(
        (
          select head.last_sequence + 1
          from system.outbox_aggregate_heads as head
          where head.aggregate_type = 'content'
            and head.aggregate_id = ${input.contentId}
        ),
        1
      )::integer as next_sequence
    `;
    const nextSequence = sequence[0]?.next_sequence;
    if (!nextSequence) throw new Error("Outbox sequence was not allocated");
    const approvalDecisionAuditId =
      input.approvedAction?.decisionAuditId ?? input.fakeApproval?.decisionAuditId;
    const approvalPendingActionId =
      input.approvedAction?.actionId ?? input.fakeApproval?.pendingActionId;
    const isApproved = approvalPendingActionId !== undefined;
    const projections = await transaction<
      Array<{
        actor_id: string;
        community_ids: string[];
        current_revision_id: string;
        kind: "post" | "reply";
        parent_content_id: string | null;
        root_content_id: string;
        symbol_ids: string[];
        topic_ids: string[];
      }>
    >`
      select
        content.author_actor_id::text as actor_id,
        content.current_revision_id::text as current_revision_id,
        content.kind,
        content.parent_id::text as parent_content_id,
        content.root_id::text as root_content_id,
        coalesce((
          select array_agg(
            distinct placement.community_id::text
            order by placement.community_id::text
          )
          from (
            select root.primary_community_id as community_id
            union
            select additional.community_id
            from platform.content_additional_communities as additional
            where additional.content_id = root.id
          ) as placement
          where placement.community_id is not null
        ), array[]::text[]) as community_ids,
        coalesce((
          select array_agg(
            distinct classification.symbol_id::text
            order by classification.symbol_id::text
          )
          from platform.content_symbols as classification
          where classification.content_id in (content.id, root.id)
        ), array[]::text[]) as symbol_ids,
        coalesce((
          select array_agg(
            distinct classification.topic_id::text
            order by classification.topic_id::text
          )
          from platform.content_topics as classification
          where classification.content_id in (content.id, root.id)
        ), array[]::text[]) as topic_ids
      from platform.content_items as content
      join platform.content_items as root on root.id = content.root_id
      where content.id = ${input.contentId}
      limit 1
    `;
    const projection = projections[0];
    if (!projection) throw new Error("Content Outbox projection was not found");
    const canonicalPayload =
      input.eventType === "content.published" || input.eventType === "content.reply"
        ? {
            actor_id: projection.actor_id,
            community_ids: projection.community_ids,
            content_id: input.contentId,
            kind: projection.kind,
            parent_content_id: projection.parent_content_id,
            revision_id: projection.current_revision_id,
            root_content_id: projection.root_content_id,
            symbol_ids: projection.symbol_ids,
            topic_ids: projection.topic_ids,
          }
        : input.eventType === "content.revised"
          ? {
              actor_id: projection.actor_id,
              affected_symbol_ids: projection.symbol_ids,
              affected_topic_ids: projection.topic_ids,
              changed_groups:
                input.revisionId === null
                  ? ["additional_community_ids", "symbols", "topics"]
                  : ["body_markdown"],
              community_ids: projection.community_ids,
              content_id: input.contentId,
              resource_version: input.resourceVersion,
              revision_id: input.revisionId,
              root_content_id: projection.root_content_id,
              symbol_ids: projection.symbol_ids,
              topic_ids: projection.topic_ids,
            }
          : {
              actor_id: projection.actor_id,
              content_id: input.contentId,
              current_revision_id: projection.current_revision_id,
              kind: projection.kind,
              lifecycle_state: "deleted",
              resource_version: input.resourceVersion,
              root_content_id: projection.root_content_id,
            };
    if (
      typeof input.payload !== "object" ||
      input.payload === null ||
      Array.isArray(input.payload)
    ) {
      throw new Error("Content Outbox fixture payload must be an object");
    }
    const completePayload = { ...canonicalPayload, ...input.payload };
    const occurredAt = new Date();
    await transaction`
      insert into system.outbox_events (
        id,
        aggregate_type,
        aggregate_id,
        aggregate_sequence,
        event_type,
        event_version,
        payload,
        occurred_at,
        available_at,
        created_at
      )
      values (
        ${outboxId},
        'content',
        ${input.contentId},
        ${nextSequence},
        ${input.eventType},
        1,
        ${transaction.json(completePayload)},
        ${occurredAt},
        ${occurredAt},
        ${occurredAt}
      )
    `;
    if (input.approvedAction) {
      const completed = await transaction<{ id: string }[]>`
        update platform.pending_actions
        set state = 'succeeded',
            version = version + 1,
            result = ${transaction.json(
              input.operation === "delete_content"
                ? {
                    content_id: input.contentId,
                    lifecycle_state: "deleted",
                    resource_version: input.resourceVersion,
                  }
                : {
                    content_id: input.contentId,
                    resource_version: input.resourceVersion,
                    revision_id: input.revisionId,
                  },
            )}
        where id = ${input.approvedAction.actionId}
          and state = 'executing'
          and attempt_count = 1
          and lease_owner = 'content-revision-schema-worker'
          and lease_token_digest = ${input.approvedAction.leaseToken}
          and lease_expires_at > clock_timestamp()
        returning id
      `;
      expect(completed).toEqual([{ id: input.approvedAction.actionId }]);
    }
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
        approval_method,
        approved_by_owner_id,
        authentication_assurance,
        authorization_snapshot,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        outbox_event_id,
        policy_version,
        request_id,
        after_state
      )
      values (
        ${randomUUID()},
        'domain_write',
        ${runtimeActorId},
        'agent',
        ${authorOwnerId},
        ${runtimeAgentId},
        ${runtimeCredentialId},
        'rest',
        ${isApproved ? "owner_approval" : "policy_auto"},
        ${isApproved ? authorOwnerId : null},
        ${isApproved ? "owner_approval_record" : "agent_credential"},
        ${transaction.json(
          isApproved
            ? {
                decision: "require_approval",
                owner_approval: {
                  decision_audit_id: approvalDecisionAuditId,
                  method: "owner_approval",
                },
              }
            : { decision: "allow" },
        )},
        ${input.action},
        'content',
        ${input.contentId},
        ${isApproved ? "require_approval" : "allow"},
        'succeeded',
        ${outboxId},
        ${runtimePolicyVersion},
        ${`revision-runtime-${randomUUID()}`},
        ${transaction.json({
          content_id: input.contentId,
          idempotency_record_id: input.idempotencyId,
          ...(input.operation === "delete_content"
            ? { lifecycle_state: "deleted" }
            : { revision_id: input.revisionId }),
          ...(approvalPendingActionId
            ? { pending_action_id: approvalPendingActionId }
            : {}),
          resource_version: input.resourceVersion,
        })}
      )
    `;
    const finalized = await transaction<{ id: string }[]>`
      update platform.idempotency_records
      set status = 'succeeded',
          response_code = ${input.responseCode},
          response_body = ${transaction.json({
            operation: input.operation,
            status: "succeeded",
          })},
          resource_id = ${input.contentId},
          terminal_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where id = ${input.idempotencyId}
        and status = ${input.approvedAction ? "pending_approval" : "in_progress"}
      returning id
    `;
    expect(finalized).toEqual([{ id: input.idempotencyId }]);
  }

  async function createApprovedAction(input: {
    action:
      | "content.create_post"
      | "content.delete_content"
      | "content.reply_to_content"
      | "content.update_content";
    expectedVersion?: number;
    operation: "create_post" | "delete_content" | "reply_to_content" | "update_content";
    targetId: string;
  }): Promise<ApprovedActionFixture> {
    const actionId = randomUUID();
    const requestAuditId = randomUUID();
    const decisionAuditId = randomUUID();
    const idempotencyId = randomUUID();
    const pendingOutboxId = randomUUID();
    const idempotencyKey = `approved-${input.operation}-${randomUUID()}`;
    const requestDigest = createHash("sha256").update(idempotencyKey).digest();
    const leaseToken = randomBytes(32);
    const targetType = input.operation === "create_post" ? "community" : "content";

    await postgres.sql.begin(async (transaction) => {
      await insertInProgressIdempotency(transaction, {
        id: idempotencyId,
        key: idempotencyKey,
        operation: input.operation,
      });
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
          ${pendingOutboxId},
          'pending_action',
          ${actionId},
          1,
          'action.pending_approval',
          ${transaction.json({ action_id: actionId })}
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
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          outbox_event_id,
          policy_version,
          request_id,
          after_state,
          reason_code
        )
        values (
          ${requestAuditId},
          'domain_write',
          ${runtimeActorId},
          'agent',
          ${authorOwnerId},
          ${runtimeAgentId},
          ${runtimeCredentialId},
          'rest',
          'agent_credential',
          '{"decision":"require_approval"}'::jsonb,
          ${input.action},
          ${targetType},
          ${input.targetId},
          'require_approval',
          'pending',
          ${pendingOutboxId},
          ${runtimePolicyVersion},
          ${`revision-pending-${randomUUID()}`},
          ${transaction.json({ pending_action_id: actionId })},
          'assisted_policy'
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
          expected_version,
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
          ${authorOwnerId},
          ${runtimeAgentId},
          ${runtimeCredentialId},
          ${`credential:${runtimeCredentialId}`},
          ${input.operation},
          ${targetType},
          ${input.targetId},
          ${input.expectedVersion ?? null},
          ${randomBytes(48)},
          ${randomBytes(12)},
          1,
          ${requestDigest},
          ${idempotencyKey},
          ${idempotencyId},
          ${randomUUID()},
          ${runtimePolicyId},
          ${runtimePolicyVersion},
          '{"decision":"require_approval","layers":[]}'::jsonb,
          'Approved Content Revision schema fixture.',
          clock_timestamp() + interval '1 day',
          ${requestAuditId}
        )
      `;
      await transaction`
        update platform.idempotency_records
        set status = 'pending_approval',
            response_code = 202,
            response_body = '{"status":"pending_approval"}'::jsonb,
            pending_action_id = ${actionId},
            updated_at = clock_timestamp()
        where id = ${idempotencyId}
      `;
      await transaction`
        insert into platform.action_logs (
          id,
          event_class,
          owner_id,
          agent_id,
          channel,
          approval_method,
          approved_by_owner_id,
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          policy_version,
          request_id,
          reason_code
        )
        values (
          ${decisionAuditId},
          'approval_transition',
          ${authorOwnerId},
          ${runtimeAgentId},
          'owner_api',
          'owner_approval',
          ${authorOwnerId},
          'owner_session',
          '{"owner_session":true}'::jsonb,
          'pending_action.approve',
          'pending_action',
          ${actionId},
          'require_approval',
          'succeeded',
          ${runtimePolicyVersion},
          ${`revision-approve-${randomUUID()}`},
          'owner_approved'
        )
      `;
      await transaction`
        update platform.pending_actions
        set state = 'approved',
            version = version + 1,
            decided_at = clock_timestamp(),
            decided_by_owner_id = ${authorOwnerId},
            approval_method = 'owner_approval',
            decision_reason_code = 'owner_approved',
            decision_audit_id = ${decisionAuditId}
        where id = ${actionId}
          and state = 'pending_approval'
      `;
      await transaction`
        update platform.pending_actions
        set state = 'executing',
            version = version + 1,
            executing_at = statement_timestamp(),
            lease_owner = 'content-revision-schema-worker',
            lease_token_digest = ${leaseToken},
            lease_expires_at = statement_timestamp() + interval '30 seconds',
            last_heartbeat_at = statement_timestamp(),
            attempt_count = attempt_count + 1,
            next_attempt_at = null
        where id = ${actionId}
          and state = 'approved'
      `;
    });

    return { actionId, decisionAuditId, idempotencyId, leaseToken };
  }

  async function createHumanActor(label: string): Promise<string> {
    const userId = randomUUID();
    const actorId = randomUUID();
    await postgres.sql`
      insert into auth.users (
        id,
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${userId},
        ${`Revision ${label}`},
        ${`revision-${label}-${userId.slice(0, 8)}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${userId}
    `;
    const ownerId = requireId(owners[0]?.id, `${label} Owner`);
    await postgres.sql`
      insert into platform.actors (
        id,
        kind,
        owner_id,
        handle,
        display_name,
        status
      )
      values (
        ${actorId},
        'human',
        ${ownerId},
        ${`revision-${actorId.replaceAll("-", "").slice(0, 16)}`},
        ${`Revision ${label}`},
        'active'
      )
    `;
    return actorId;
  }

  async function createPost(
    label: string,
    actorId = authorActorId,
  ): Promise<{
    contentId: string;
    revisionId: string;
  }> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Immutable Revision fixture ${label} ${contentId}`;
    await postgres.sql.begin(async (transaction) => {
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
          ${contentId},
          'post',
          ${actorId},
          ${primaryCommunityId},
          ${contentId},
          0
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
          ${`Revision fixture ${label}`},
          ${body},
          ${body},
          ${actorId},
          1,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
      `;
      const occurredAt = new Date();
      await transaction`
        insert into system.outbox_events (
          id,
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          event_version,
          payload,
          occurred_at,
          available_at,
          max_attempts,
          created_at
        )
        values (
          ${randomUUID()},
          'content',
          ${contentId},
          1,
          'content.published',
          1,
          ${transaction.json({
            actor_id: actorId,
            community_ids: [primaryCommunityId],
            content_id: contentId,
            kind: "post",
            parent_content_id: null,
            revision_id: revisionId,
            root_content_id: contentId,
            symbol_ids: [],
            topic_ids: [],
          })},
          ${occurredAt},
          ${occurredAt},
          12,
          ${occurredAt}
        )
      `;
    });
    return { contentId, revisionId };
  }

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 8);
    authorActorId = await createHumanActor(`${marker}-author`);
    alternateActorId = await createHumanActor(`${marker}-alternate`);
    primaryCommunityId = randomUUID();
    alternateCommunityId = randomUUID();
    tertiaryCommunityId = randomUUID();
    primarySymbolId = randomUUID();
    alternateSymbolId = randomUUID();
    primaryTopicId = randomUUID();
    alternateTopicId = randomUUID();
    runtimeRole = `alphanet_revision_rt_${marker}`;
    const owners = await postgres.sql<{ owner_id: string }[]>`
      select owner_id
      from platform.actors
      where id = ${authorActorId}
    `;
    authorOwnerId = requireId(owners[0]?.owner_id, "author Owner");
    const created = await agentService.createAgent(
      authorOwnerId,
      {
        displayName: "Content Revision Runtime Agent",
        handle: `revision-runtime-${marker}`,
      },
      randomUUID(),
    );
    runtimeActorId = created.agent.actorId;
    runtimeAgentId = created.agent.id;
    runtimePolicyId = created.agent.policy.id;
    runtimePolicyVersion = created.agent.policy.version;
    const credential = await agentService.createCredential(
      authorOwnerId,
      runtimeAgentId,
      {
        name: "Content Revision Runtime schema tests",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    runtimeCredentialId = credential.credential.id;
    await postgres.sql`
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
          ${`revision-primary-${marker}`},
          'Revision Primary Community',
          'Primary Community for Content Revision guardrail tests.',
          'general'
        ),
        (
          ${alternateCommunityId},
          ${`revision-alternate-${marker}`},
          'Revision Alternate Community',
          'Alternate Community for Content Revision guardrail tests.',
          'general'
        ),
        (
          ${tertiaryCommunityId},
          ${`revision-tertiary-${marker}`},
          'Revision Tertiary Community',
          'Tertiary Community for Content Revision guardrail tests.',
          'general'
        )
    `;
    await postgres.sql`
      insert into platform.symbols (id, ticker, exchange, name)
      values
        (
          ${primarySymbolId},
          ${`R${marker.toUpperCase()}`},
          'TEST',
          'Revision Primary Symbol'
        ),
        (
          ${alternateSymbolId},
          ${`S${marker.toUpperCase()}`},
          'TEST',
          'Revision Alternate Symbol'
        )
    `;
    await postgres.sql`
      insert into platform.topics (id, slug, name)
      values
        (
          ${primaryTopicId},
          ${`revision-${marker}-primary`},
          'Revision Primary Topic'
        ),
        (
          ${alternateTopicId},
          ${`revision-${marker}-alternate`},
          'Revision Alternate Topic'
        )
    `;

    const currentRoles = await postgres.sql<{ current_user: string }[]>`
      select current_user
    `;
    const testOwnerRole = requireId(currentRoles[0]?.current_user, "test database role");
    await postgres.sql.unsafe(`
      create role ${quoteRole(runtimeRole)}
        nologin noinherit nosuperuser nocreatedb nocreaterole
        noreplication nobypassrls
    `);
    await postgres.sql.unsafe(
      `grant ${quoteRole(runtimeRole)} to ${quoteRole(testOwnerRole)}`,
    );
    await postgres.sql.unsafe(
      `grant usage on schema platform, system to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant select on all tables in schema platform, system to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(`
      grant insert on table
        platform.action_logs,
        platform.content_additional_communities,
        platform.content_items,
        platform.content_relations,
        platform.content_revisions,
        platform.content_symbols,
        platform.content_topics,
        platform.idempotency_records,
        platform.mentions,
        platform.source_links,
        system.outbox_aggregate_heads,
        system.outbox_events
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant delete on table
        platform.content_additional_communities,
        platform.content_symbols,
        platform.content_topics
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant update (
        version,
        current_revision_id,
        lifecycle_state,
        deleted_at
      )
      on table platform.content_items to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant update (removed_revision_id)
      on table platform.source_links, platform.content_relations
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant update on table
        platform.idempotency_records,
        platform.pending_actions,
        system.outbox_aggregate_heads
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant execute on function
        platform.audit_json_is_secret_free(jsonb),
        platform.audit_json_is_secret_free_v2(jsonb),
        system.content_v1_outbox_payload_is_valid(text, text, text, integer, jsonb)
      to ${quoteRole(runtimeRole)}
    `);
  });

  afterAll(async () => {
    if (runtimeRole) {
      const currentRoles = await postgres.sql<{ current_user: string }[]>`
        select current_user
      `;
      const testOwnerRole = requireId(
        currentRoles[0]?.current_user,
        "test database role",
      );
      await postgres.sql.unsafe(`drop owned by ${quoteRole(runtimeRole)}`);
      await postgres.sql.unsafe(
        `revoke ${quoteRole(runtimeRole)} from ${quoteRole(testOwnerRole)}`,
      );
      await postgres.sql.unsafe(`drop role ${quoteRole(runtimeRole)}`);
    }
    await closeDependencies(dependencies);
  });

  it("records the exact forward migration and installs the Revision pointer trigger", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000012_content_revision_write.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(checksum).toBe(CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM);

    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000012'
    `;
    expect(ledger).toEqual([
      {
        checksum: CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM,
        name: "content_revision_write",
        version: "000012",
      },
    ]);

    const shape = await postgres.sql<
      {
        admission_rate_index: boolean;
        constraint_trigger: boolean;
        provenance_guard: boolean;
        provenance_trigger_count: number;
        relation_guard: boolean;
        revision_guard: boolean;
      }[]
    >`
      select
        to_regclass(
          'platform.content_additional_communities_admission_rate_idx'
        ) is not null as admission_rate_index,
        exists (
          select 1
          from pg_proc as routine
          join pg_namespace as namespace
            on namespace.oid = routine.pronamespace
          where namespace.nspname = 'platform'
            and routine.proname = 'validate_runtime_content_write_provenance'
            and routine.pronargs = 0
            and routine.oid =
              'platform.validate_runtime_content_write_provenance()'::regprocedure
            and not routine.prosecdef
            and 'search_path=pg_catalog' = any (routine.proconfig)
        ) as provenance_guard,
        (
          select count(*)::integer
          from (
            values
              (
                'platform.content_items'::regclass,
                'content_items_validate_runtime_provenance',
                21::smallint
              ),
              (
                'platform.content_additional_communities'::regclass,
                'content_additional_communities_validate_runtime_provenance',
                29::smallint
              ),
              (
                'platform.content_symbols'::regclass,
                'content_symbols_validate_runtime_provenance',
                29::smallint
              ),
              (
                'platform.content_topics'::regclass,
                'content_topics_validate_runtime_provenance',
                29::smallint
              ),
              (
                'platform.source_links'::regclass,
                'source_links_validate_runtime_provenance',
                21::smallint
              ),
              (
                'platform.content_relations'::regclass,
                'content_relations_validate_runtime_provenance',
                21::smallint
              ),
              (
                'platform.mentions'::regclass,
                'mentions_validate_runtime_provenance',
                5::smallint
              )
          ) as expected(relation_id, trigger_name, trigger_type)
          join pg_trigger as trigger
            on trigger.tgrelid = expected.relation_id
           and trigger.tgname = expected.trigger_name
           and trigger.tgtype = expected.trigger_type
          join pg_proc as routine on routine.oid = trigger.tgfoid
          join pg_namespace as namespace on namespace.oid = routine.pronamespace
          where not trigger.tgisinternal
            and trigger.tgconstraint <> 0
            and trigger.tgdeferrable
            and trigger.tginitdeferred
            and trigger.tgenabled in ('O', 'A')
            and namespace.nspname = 'platform'
            and routine.proname = 'validate_runtime_content_write_provenance'
            and routine.pronargs = 0
            and trigger.tgfoid =
              'platform.validate_runtime_content_write_provenance()'::regprocedure
        ) as provenance_trigger_count,
        exists (
          select 1
          from pg_trigger
          where tgrelid = 'platform.content_revisions'::regclass
            and tgname = 'content_revisions_validate_current_pointer'
            and tgconstraint <> 0
            and tgdeferrable
            and tginitdeferred
        ) as constraint_trigger,
        position(
          'in-progress newest author Revision'
          in pg_get_functiondef(
            'platform.prepare_revision_relation_update()'::regprocedure
          )
        ) > 0 as relation_guard,
        position(
          'source version must equal the Content command version'
          in pg_get_functiondef(
            'platform.validate_content_revision_insert()'::regprocedure
          )
        ) > 0 as revision_guard
    `;
    expect(shape).toEqual([
      {
        admission_rate_index: true,
        constraint_trigger: true,
        provenance_guard: true,
        provenance_trigger_count: 7,
        relation_guard: true,
        revision_guard: true,
      },
    ]);
  });

  it("records Content Delete/Anti-spam v1 and installs its bounded query paths", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000014_content_delete_antispam_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(checksum).toBe(CONTENT_DELETE_ANTISPAM_MIGRATION_CHECKSUM);

    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000014'
    `;
    expect(ledger).toEqual([
      {
        checksum: CONTENT_DELETE_ANTISPAM_MIGRATION_CHECKSUM,
        name: "content_delete_antispam_v1",
        version: "000014",
      },
    ]);

    const shape = await postgres.sql<
      {
        actor_hash_index: boolean;
        delete_action: boolean;
        delete_event: boolean;
        owner_publish_index: boolean;
        reply_burst_index: boolean;
      }[]
    >`
      select
        to_regclass(
          'platform.content_revisions_actor_hash_recent_idx'
        ) is not null as actor_hash_index,
        to_regclass(
          'platform.content_items_reply_root_author_published_idx'
        ) is not null as reply_burst_index,
        to_regclass(
          'platform.action_logs_owner_content_publish_succeeded_idx'
        ) is not null as owner_publish_index,
        position(
          'content.delete_content'
          in pg_get_functiondef(
            'platform.validate_runtime_content_write_provenance()'::regprocedure
          )
        ) > 0 as delete_action,
        position(
          'content.deleted'
          in pg_get_functiondef(
            'platform.validate_runtime_content_write_provenance()'::regprocedure
          )
        ) > 0 as delete_event
    `;
    expect(shape).toEqual([
      {
        actor_hash_index: true,
        delete_action: true,
        delete_event: true,
        owner_publish_index: true,
        reply_burst_index: true,
      },
    ]);
  });

  it("rejects Runtime facts attached directly to an existing Content or Revision", async () => {
    const content = await createPost("runtime-direct-facts");
    const target = await createPost("runtime-direct-facts-target");
    const sourceUrl = `https://example.test/runtime-direct/${randomUUID()}`;

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.source_links (
            id,
            content_id,
            position,
            url,
            normalized_url_hash,
            added_revision_id,
            added_by_actor_id
          )
          values (
            ${randomUUID()},
            ${content.contentId},
            1,
            ${sourceUrl},
            ${createHash("sha256").update(sourceUrl).digest()},
            ${content.revisionId},
            ${authorActorId}
          )
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);

    await expect(
      asRuntime(async (transaction) => {
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
            ${randomUUID()},
            ${content.contentId},
            ${target.contentId},
            1,
            'reference',
            ${content.revisionId}
          )
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.mentions (
            revision_id,
            content_id,
            revision_number,
            mentioned_actor_id,
            position
          )
          values (
            ${content.revisionId},
            ${content.contentId},
            1,
            ${alternateActorId},
            1
          )
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
  });

  it("rejects silent Runtime placement and classification inserts or deletes", async () => {
    const content = await createPost("runtime-direct-classification");
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_additional_communities (
          content_id,
          community_id,
          position
        )
        values (${content.contentId}, ${alternateCommunityId}, 1)
      `;
      await transaction`
        insert into platform.content_symbols (content_id, symbol_id, position)
        values (${content.contentId}, ${primarySymbolId}, 1)
      `;
      await transaction`
        insert into platform.content_topics (content_id, topic_id, position)
        values (${content.contentId}, ${primaryTopicId}, 1)
      `;
    });

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.content_additional_communities (
            content_id,
            community_id,
            position
          )
          values (${content.contentId}, ${tertiaryCommunityId}, 2)
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.content_symbols (content_id, symbol_id, position)
          values (${content.contentId}, ${alternateSymbolId}, 2)
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.content_topics (content_id, topic_id, position)
          values (${content.contentId}, ${alternateTopicId}, 2)
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          delete from platform.content_additional_communities
          where content_id = ${content.contentId}
            and community_id = ${alternateCommunityId}
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          delete from platform.content_symbols
          where content_id = ${content.contentId}
            and symbol_id = ${primarySymbolId}
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          delete from platform.content_topics
          where content_id = ${content.contentId}
            and topic_id = ${primaryTopicId}
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);
  });

  it("rejects a raw Runtime soft delete without complete provenance", async () => {
    const content = await createPost("runtime-raw-delete", runtimeActorId);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          update platform.content_items
          set version = version + 1,
              lifecycle_state = 'deleted',
              deleted_at = clock_timestamp()
          where id = ${content.contentId}
            and version = 1
            and lifecycle_state = 'published'
        `;
      }),
    ).rejects.toThrow(/Outbox, audit, and idempotency provenance/u);

    const unchanged = await postgres.sql<
      { current_revision_id: string; lifecycle_state: string; version: number }[]
    >`
      select
        current_revision_id,
        lifecycle_state,
        version::integer as version
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(unchanged).toEqual([
      {
        current_revision_id: content.revisionId,
        lifecycle_state: "published",
        version: 1,
      },
    ]);
  });

  it("rejects a Runtime delete that also replaces the current Revision", async () => {
    const content = await createPost("runtime-delete-revision", runtimeActorId);
    const replacementRevisionId = randomUUID();

    await expect(
      asRuntime(async (transaction) => {
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
            ${replacementRevisionId},
            ${content.contentId},
            2,
            'Delete must retain Revision',
            'A soft-delete command cannot publish a replacement Revision.',
            'A soft-delete command cannot publish a replacement Revision.',
            ${runtimeActorId},
            2,
            ${randomBytes(32)},
            512
          )
        `;
        await transaction`
          update platform.content_items
          set version = 2,
              current_revision_id = ${replacementRevisionId},
              lifecycle_state = 'deleted',
              deleted_at = clock_timestamp()
          where id = ${content.contentId}
            and version = 1
            and lifecycle_state = 'published'
        `;
      }),
    ).rejects.toThrow(/may change only version, lifecycle state, and deletion time/u);

    const unchanged = await postgres.sql<
      { current_revision_id: string; revisions: number; version: number }[]
    >`
      select
        content.current_revision_id,
        count(revision.id)::integer as revisions,
        content.version::integer as version
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.content_id = content.id
      where content.id = ${content.contentId}
      group by content.id
    `;
    expect(unchanged).toEqual([
      {
        current_revision_id: content.revisionId,
        revisions: 1,
        version: 1,
      },
    ]);
  });

  it("allows a complete Runtime create-post command with initial facts", async () => {
    const target = await createPost("runtime-create-target");
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyId = randomUUID();
    const sourceUrl = `https://example.test/runtime-create/${contentId}`;

    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, {
        id: idempotencyId,
        key: `runtime-create-${contentId}`,
        operation: "create_post",
      });
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
          ${contentId},
          'post',
          ${runtimeActorId},
          ${primaryCommunityId},
          ${contentId},
          0
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
          'Runtime create provenance',
          'A complete Runtime create command may commit all initial facts.',
          'A complete Runtime create command may commit all initial facts.',
          ${runtimeActorId},
          1,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId} and current_revision_id is null
      `;
      await transaction`
        insert into platform.content_additional_communities (
          content_id,
          community_id,
          position
        )
        values (${contentId}, ${alternateCommunityId}, 1)
      `;
      await transaction`
        insert into platform.content_symbols (content_id, symbol_id, position)
        values (${contentId}, ${primarySymbolId}, 1)
      `;
      await transaction`
        insert into platform.content_topics (content_id, topic_id, position)
        values (${contentId}, ${primaryTopicId}, 1)
      `;
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          added_revision_id,
          added_by_actor_id
        )
        values (
          ${randomUUID()},
          ${contentId},
          1,
          ${sourceUrl},
          ${createHash("sha256").update(sourceUrl).digest()},
          ${revisionId},
          ${runtimeActorId}
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
          ${randomUUID()},
          ${contentId},
          ${target.contentId},
          1,
          'reference',
          ${revisionId}
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
        values (${revisionId}, ${contentId}, 1, ${alternateActorId}, 1)
      `;
      await finishContentCommand(transaction, {
        action: "content.create_post",
        contentId,
        eventType: "content.published",
        idempotencyId,
        operation: "create_post",
        payload: {
          actor_id: runtimeActorId,
          content_id: contentId,
          kind: "post",
          revision_id: revisionId,
        },
        resourceVersion: 1,
        revisionId,
        responseCode: 201,
      });
    });

    const persisted = await postgres.sql<{ version: number }[]>`
      select version::integer as version
      from platform.content_items
      where id = ${contentId}
    `;
    expect(persisted).toEqual([{ version: 1 }]);
  });

  it("allows an Owner-approved Runtime create-post command", async () => {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const approvedAction = await createApprovedAction({
      action: "content.create_post",
      operation: "create_post",
      targetId: primaryCommunityId,
    });

    await asRuntime(async (transaction) => {
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
          ${contentId},
          'post',
          ${runtimeActorId},
          ${primaryCommunityId},
          ${contentId},
          0
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
          'Approved Runtime create provenance',
          'A real approved action may create Content in one SAVEPOINT.',
          'A real approved action may create Content in one SAVEPOINT.',
          ${runtimeActorId},
          1,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId} and current_revision_id is null
      `;
      await finishContentCommand(transaction, {
        action: "content.create_post",
        approvedAction,
        contentId,
        eventType: "content.published",
        idempotencyId: approvedAction.idempotencyId,
        operation: "create_post",
        payload: {
          actor_id: runtimeActorId,
          content_id: contentId,
          kind: "post",
          revision_id: revisionId,
        },
        resourceVersion: 1,
        revisionId,
        responseCode: 201,
      });
    });

    const persisted = await postgres.sql<{ version: number }[]>`
      select version::integer as version
      from platform.content_items
      where id = ${contentId}
    `;
    expect(persisted).toEqual([{ version: 1 }]);
  });

  it("allows an Owner-approved Runtime reply with prior idempotency", async () => {
    const parent = await createPost("runtime-reply-parent");
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const approvedAction = await createApprovedAction({
      action: "content.reply_to_content",
      operation: "reply_to_content",
      targetId: parent.contentId,
    });

    await asRuntime(async (transaction) => {
      await transaction`
        insert into platform.content_items (
          id,
          kind,
          author_actor_id,
          root_id,
          parent_id,
          depth
        )
        values (
          ${contentId},
          'reply',
          ${runtimeActorId},
          ${parent.contentId},
          ${parent.contentId},
          1
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
          null,
          'A complete Runtime reply may commit.',
          'A complete Runtime reply may commit.',
          ${runtimeActorId},
          1,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId} and current_revision_id is null
      `;
      await finishContentCommand(transaction, {
        action: "content.reply_to_content",
        approvedAction,
        contentId,
        eventType: "content.reply",
        idempotencyId: approvedAction.idempotencyId,
        operation: "reply_to_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: contentId,
          kind: "reply",
          revision_id: revisionId,
        },
        resourceVersion: 1,
        revisionId,
        responseCode: 201,
      });
    });

    const persisted = await postgres.sql<{ kind: string; version: number }[]>`
      select kind, version::integer as version
      from platform.content_items
      where id = ${contentId}
    `;
    expect(persisted).toEqual([{ kind: "reply", version: 1 }]);
  });

  it("allows an Owner-approved Runtime classification-only update", async () => {
    const content = await createPost("runtime-classification-update", runtimeActorId);
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.content_additional_communities (
          content_id,
          community_id,
          position
        )
        values (${content.contentId}, ${alternateCommunityId}, 1)
      `;
      await transaction`
        insert into platform.content_symbols (content_id, symbol_id, position)
        values (${content.contentId}, ${primarySymbolId}, 1)
      `;
      await transaction`
        insert into platform.content_topics (content_id, topic_id, position)
        values (${content.contentId}, ${primaryTopicId}, 1)
      `;
    });
    const approvedAction = await createApprovedAction({
      action: "content.update_content",
      expectedVersion: 1,
      operation: "update_content",
      targetId: content.contentId,
    });

    await asRuntime(async (transaction) => {
      await transaction`
        delete from platform.content_additional_communities
        where content_id = ${content.contentId}
      `;
      await transaction`
        insert into platform.content_additional_communities (
          content_id,
          community_id,
          position
        )
        values (${content.contentId}, ${tertiaryCommunityId}, 1)
      `;
      await transaction`
        delete from platform.content_symbols
        where content_id = ${content.contentId}
      `;
      await transaction`
        insert into platform.content_symbols (content_id, symbol_id, position)
        values (${content.contentId}, ${alternateSymbolId}, 1)
      `;
      await transaction`
        delete from platform.content_topics
        where content_id = ${content.contentId}
      `;
      await transaction`
        insert into platform.content_topics (content_id, topic_id, position)
        values (${content.contentId}, ${alternateTopicId}, 1)
      `;
      await transaction`
        update platform.content_items
        set version = 2,
            current_revision_id = ${content.revisionId}
        where id = ${content.contentId} and version = 1
      `;
      await finishContentCommand(transaction, {
        action: "content.update_content",
        approvedAction,
        contentId: content.contentId,
        eventType: "content.revised",
        idempotencyId: approvedAction.idempotencyId,
        operation: "update_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: content.contentId,
          resource_version: 2,
          revision_id: null,
        },
        resourceVersion: 2,
        revisionId: null,
        responseCode: 200,
      });
    });

    const persisted = await postgres.sql<
      { revision_id: string; symbol_id: string; topic_id: string; version: number }[]
    >`
      select
        content.current_revision_id as revision_id,
        symbol.symbol_id,
        topic.topic_id,
        content.version::integer as version
      from platform.content_items as content
      join platform.content_symbols as symbol on symbol.content_id = content.id
      join platform.content_topics as topic on topic.content_id = content.id
      where content.id = ${content.contentId}
    `;
    expect(persisted).toEqual([
      {
        revision_id: content.revisionId,
        symbol_id: alternateSymbolId,
        topic_id: alternateTopicId,
        version: 2,
      },
    ]);
  });

  it("allows a policy-auto Runtime author soft delete without changing Revision", async () => {
    const content = await createPost("runtime-auto-delete", runtimeActorId);
    const idempotencyId = randomUUID();

    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, {
        id: idempotencyId,
        key: `runtime-auto-delete-${content.contentId}`,
        operation: "delete_content",
      });
      await transaction`
        update platform.content_items
        set version = 2,
            lifecycle_state = 'deleted',
            deleted_at = clock_timestamp()
        where id = ${content.contentId}
          and version = 1
          and lifecycle_state = 'published'
      `;
      await finishContentCommand(transaction, {
        action: "content.delete_content",
        contentId: content.contentId,
        eventType: "content.deleted",
        idempotencyId,
        operation: "delete_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: content.contentId,
          current_revision_id: content.revisionId,
          kind: "post",
          lifecycle_state: "deleted",
          resource_version: 2,
          root_content_id: content.contentId,
        },
        resourceVersion: 2,
        revisionId: null,
        responseCode: 200,
      });
    });

    const persisted = await postgres.sql<
      {
        current_revision_id: string;
        deleted: boolean;
        lifecycle_state: string;
        version: number;
      }[]
    >`
      select
        current_revision_id,
        deleted_at is not null as deleted,
        lifecycle_state,
        version::integer as version
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(persisted).toEqual([
      {
        current_revision_id: content.revisionId,
        deleted: true,
        lifecycle_state: "deleted",
        version: 2,
      },
    ]);
  });

  it("allows an Owner-approved Runtime soft delete with the old expected version", async () => {
    const content = await createPost("runtime-approved-delete", runtimeActorId);
    const approvedAction = await createApprovedAction({
      action: "content.delete_content",
      expectedVersion: 1,
      operation: "delete_content",
      targetId: content.contentId,
    });

    await asRuntime(async (transaction) => {
      await transaction`
        update platform.content_items
        set version = 2,
            lifecycle_state = 'deleted',
            deleted_at = clock_timestamp()
        where id = ${content.contentId}
          and version = 1
          and lifecycle_state = 'published'
      `;
      await finishContentCommand(transaction, {
        action: "content.delete_content",
        approvedAction,
        contentId: content.contentId,
        eventType: "content.deleted",
        idempotencyId: approvedAction.idempotencyId,
        operation: "delete_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: content.contentId,
          current_revision_id: content.revisionId,
          kind: "post",
          lifecycle_state: "deleted",
          resource_version: 2,
          root_content_id: content.contentId,
        },
        resourceVersion: 2,
        revisionId: null,
        responseCode: 200,
      });
    });

    const persisted = await postgres.sql<
      {
        action_result: Record<string, unknown>;
        current_revision_id: string;
        lifecycle_state: string;
        version: number;
      }[]
    >`
      select
        action.result as action_result,
        content.current_revision_id,
        content.lifecycle_state,
        content.version::integer as version
      from platform.content_items as content
      join platform.pending_actions as action
        on action.id = ${approvedAction.actionId}
      where content.id = ${content.contentId}
    `;
    expect(persisted).toEqual([
      {
        action_result: {
          content_id: content.contentId,
          lifecycle_state: "deleted",
          resource_version: 2,
        },
        current_revision_id: content.revisionId,
        lifecycle_state: "deleted",
        version: 2,
      },
    ]);
  });

  it.each(["kind", "root_content_id", "current_revision_id"] as const)(
    "rejects a Runtime delete whose Outbox payload tampers with %s",
    async (field) => {
      const content = await createPost(
        `runtime-delete-tampered-${field}`,
        runtimeActorId,
      );
      const idempotencyId = randomUUID();
      const payload: Record<string, string | number> = {
        actor_id: runtimeActorId,
        content_id: content.contentId,
        current_revision_id: content.revisionId,
        kind: "post",
        lifecycle_state: "deleted",
        resource_version: 2,
        root_content_id: content.contentId,
      };
      payload[field] = field === "kind" ? "reply" : randomUUID();

      await expect(
        asRuntime(async (transaction) => {
          await insertInProgressIdempotency(transaction, {
            id: idempotencyId,
            key: `runtime-delete-tampered-${field}-${content.contentId}`,
            operation: "delete_content",
          });
          await transaction`
            update platform.content_items
            set version = 2,
                lifecycle_state = 'deleted',
                deleted_at = clock_timestamp()
            where id = ${content.contentId}
              and version = 1
              and lifecycle_state = 'published'
          `;
          await finishContentCommand(transaction, {
            action: "content.delete_content",
            contentId: content.contentId,
            eventType: "content.deleted",
            idempotencyId,
            operation: "delete_content",
            payload,
            resourceVersion: 2,
            revisionId: null,
            responseCode: 200,
          });
          await transaction`set constraints all immediate`;
        }),
      ).rejects.toMatchObject({ code: "23514" });

      const unchanged = await postgres.sql<
        { current_revision_id: string; lifecycle_state: string; version: number }[]
      >`
        select
          current_revision_id,
          lifecycle_state,
          version::integer as version
        from platform.content_items
        where id = ${content.contentId}
      `;
      expect(unchanged).toEqual([
        {
          current_revision_id: content.revisionId,
          lifecycle_state: "published",
          version: 1,
        },
      ]);
    },
  );

  it("allows a complete Runtime author-Revision update", async () => {
    const content = await createPost("runtime-revision-update", runtimeActorId);
    const target = await createPost("runtime-revision-update-target");
    const oldSourceId = randomUUID();
    const oldRelationId = randomUUID();
    const oldSourceUrl = `https://example.test/runtime-old/${oldSourceId}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          added_revision_id,
          added_by_actor_id
        )
        values (
          ${oldSourceId},
          ${content.contentId},
          1,
          ${oldSourceUrl},
          ${createHash("sha256").update(oldSourceUrl).digest()},
          ${content.revisionId},
          ${runtimeActorId}
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
          ${oldRelationId},
          ${content.contentId},
          ${target.contentId},
          1,
          'reference',
          ${content.revisionId}
        )
      `;
    });

    const revisionId = randomUUID();
    const idempotencyId = randomUUID();
    const newSourceUrl = `https://example.test/runtime-new/${revisionId}`;
    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, {
        id: idempotencyId,
        key: `runtime-revision-${content.contentId}`,
        operation: "update_content",
      });
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
          ${content.contentId},
          2,
          'Runtime Revision update',
          'A complete Runtime edit may publish a new immutable Revision.',
          'A complete Runtime edit may publish a new immutable Revision.',
          'Refresh the source and reference facts.',
          ${runtimeActorId},
          2,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.source_links
        set removed_revision_id = ${revisionId}
        where id = ${oldSourceId} and removed_revision_id is null
      `;
      await transaction`
        update platform.content_relations
        set removed_revision_id = ${revisionId}
        where id = ${oldRelationId} and removed_revision_id is null
      `;
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          added_revision_id,
          added_by_actor_id
        )
        values (
          ${randomUUID()},
          ${content.contentId},
          1,
          ${newSourceUrl},
          ${createHash("sha256").update(newSourceUrl).digest()},
          ${revisionId},
          ${runtimeActorId}
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
          ${randomUUID()},
          ${content.contentId},
          ${target.contentId},
          1,
          'quote',
          ${revisionId}
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
        values (${revisionId}, ${content.contentId}, 2, ${alternateActorId}, 1)
      `;
      await transaction`
        update platform.content_items
        set version = 2, current_revision_id = ${revisionId}
        where id = ${content.contentId} and version = 1
      `;
      await finishContentCommand(transaction, {
        action: "content.update_content",
        contentId: content.contentId,
        eventType: "content.revised",
        idempotencyId,
        operation: "update_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: content.contentId,
          resource_version: 2,
          revision_id: revisionId,
        },
        resourceVersion: 2,
        revisionId,
        responseCode: 200,
      });
    });

    const persisted = await postgres.sql<
      {
        active_relations: number;
        active_sources: number;
        current_revision_id: string;
        version: number;
      }[]
    >`
      select
        content.current_revision_id,
        content.version::integer as version,
        count(distinct source.id) filter (
          where source.removed_revision_id is null
        )::integer as active_sources,
        count(distinct relation.id) filter (
          where relation.removed_revision_id is null
        )::integer as active_relations
      from platform.content_items as content
      left join platform.source_links as source on source.content_id = content.id
      left join platform.content_relations as relation
        on relation.from_content_id = content.id
      where content.id = ${content.contentId}
      group by content.id
    `;
    expect(persisted).toEqual([
      {
        active_relations: 1,
        active_sources: 1,
        current_revision_id: revisionId,
        version: 2,
      },
    ]);
  });

  it("allows a protected Content event after another aggregate event advances its sequence", async () => {
    const content = await createPost("runtime-sequence-divergence", runtimeActorId);
    const unrelatedEventAt = new Date();
    await postgres.sql`
      insert into system.outbox_events (
        id,
        aggregate_type,
        aggregate_id,
        aggregate_sequence,
        event_type,
        event_version,
        payload,
        occurred_at,
        available_at,
        max_attempts,
        created_at
      )
      values (
        ${randomUUID()},
        'content',
        ${content.contentId},
        2,
        'content.moderation_changed',
        1,
        ${postgres.sql.json({ content_id: content.contentId })},
        ${unrelatedEventAt},
        ${unrelatedEventAt},
        12,
        ${unrelatedEventAt}
      )
    `;
    const idempotencyId = randomUUID();

    await expect(
      asRuntime(async (transaction) => {
        await insertInProgressIdempotency(transaction, {
          id: idempotencyId,
          key: `runtime-sequence-divergence-${content.contentId}`,
          operation: "update_content",
        });
        await transaction`
          update platform.content_items
          set version = 2,
              current_revision_id = ${content.revisionId}
          where id = ${content.contentId} and version = 1
        `;
        await finishContentCommand(transaction, {
          action: "content.update_content",
          contentId: content.contentId,
          eventType: "content.revised",
          idempotencyId,
          operation: "update_content",
          payload: {
            actor_id: runtimeActorId,
            content_id: content.contentId,
            resource_version: 2,
            revision_id: null,
          },
          resourceVersion: 2,
          revisionId: null,
          responseCode: 200,
        });
        await transaction`set constraints all immediate`;
      }),
    ).resolves.toBeUndefined();

    const persisted = await postgres.sql<
      { aggregate_sequence: number; event_type: string; version: number }[]
    >`
      select
        content.version::integer as version,
        event.aggregate_sequence::integer as aggregate_sequence,
        event.event_type
      from platform.content_items as content
      join system.outbox_events as event
        on event.aggregate_type = 'content'
       and event.aggregate_id = content.id::text
       and event.event_type = 'content.revised'
      where content.id = ${content.contentId}
    `;
    expect(persisted).toEqual([
      {
        aggregate_sequence: 3,
        event_type: "content.revised",
        version: 2,
      },
    ]);
  });

  it("rejects a forged Owner approval without a real PendingAction chain", async () => {
    const content = await createPost("runtime-forged-approval", runtimeActorId);
    const idempotencyId = randomUUID();

    await expect(
      asRuntime(async (transaction) => {
        await insertInProgressIdempotency(transaction, {
          id: idempotencyId,
          key: `runtime-forged-approval-${content.contentId}`,
          operation: "update_content",
        });
        await transaction`
          update platform.content_items
          set version = 2,
              current_revision_id = ${content.revisionId}
          where id = ${content.contentId} and version = 1
        `;
        await finishContentCommand(transaction, {
          action: "content.update_content",
          contentId: content.contentId,
          eventType: "content.revised",
          fakeApproval: {
            decisionAuditId: randomUUID(),
            pendingActionId: randomUUID(),
          },
          idempotencyId,
          operation: "update_content",
          payload: {
            actor_id: runtimeActorId,
            content_id: content.contentId,
            resource_version: 2,
            revision_id: null,
          },
          resourceVersion: 2,
          revisionId: null,
          responseCode: 200,
        });
      }),
    ).rejects.toThrow(/Outbox, audit, and idempotency provenance/u);

    const unchanged = await postgres.sql<{ version: number }[]>`
      select version::integer as version
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(unchanged).toEqual([{ version: 1 }]);
  });

  it("rejects Runtime create-and-update folding inside one SAVEPOINT", async () => {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyId = randomUUID();

    await expect(
      asRuntime(async (transaction) => {
        await insertInProgressIdempotency(transaction, {
          id: idempotencyId,
          key: `runtime-create-update-${contentId}`,
          operation: "update_content",
        });
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
            ${contentId},
            'post',
            ${runtimeActorId},
            ${primaryCommunityId},
            ${contentId},
            0
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
            'Folded Runtime command',
            'One CREATE and UPDATE cannot be folded into one provenance bundle.',
            'One CREATE and UPDATE cannot be folded into one provenance bundle.',
            ${runtimeActorId},
            1,
            ${randomBytes(32)},
            512
          )
        `;
        await transaction`
          update platform.content_items
          set current_revision_id = ${revisionId}
          where id = ${contentId} and current_revision_id is null
        `;
        await transaction`
          update platform.content_items
          set version = 2,
              current_revision_id = ${revisionId}
          where id = ${contentId} and version = 1
        `;
        await finishContentCommand(transaction, {
          action: "content.update_content",
          contentId,
          eventType: "content.revised",
          idempotencyId,
          operation: "update_content",
          payload: {
            actor_id: runtimeActorId,
            content_id: contentId,
            resource_version: 2,
            revision_id: null,
          },
          resourceVersion: 2,
          revisionId: null,
          responseCode: 200,
        });
      }),
    ).rejects.toThrow(/event version was superseded/u);

    const missing = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.content_items
      where id = ${contentId}
    `;
    expect(missing).toEqual([{ count: 0 }]);
  });

  it("rejects two Runtime Content updates folded into one SAVEPOINT", async () => {
    const content = await createPost("runtime-double-update", runtimeActorId);
    const idempotencyId = randomUUID();

    await expect(
      asRuntime(async (transaction) => {
        await insertInProgressIdempotency(transaction, {
          id: idempotencyId,
          key: `runtime-double-update-${content.contentId}`,
          operation: "update_content",
        });
        await transaction`
          update platform.content_items
          set version = 2,
              current_revision_id = ${content.revisionId}
          where id = ${content.contentId} and version = 1
        `;
        await transaction`
          update platform.content_items
          set version = 3,
              current_revision_id = ${content.revisionId}
          where id = ${content.contentId} and version = 2
        `;
        await finishContentCommand(transaction, {
          action: "content.update_content",
          contentId: content.contentId,
          eventType: "content.revised",
          idempotencyId,
          operation: "update_content",
          payload: {
            actor_id: runtimeActorId,
            content_id: content.contentId,
            resource_version: 3,
            revision_id: null,
          },
          resourceVersion: 3,
          revisionId: null,
          responseCode: 200,
        });
      }),
    ).rejects.toThrow(/event version was superseded/u);

    const unchanged = await postgres.sql<{ version: number }[]>`
      select version::integer as version
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(unchanged).toEqual([{ version: 1 }]);
  });

  it("rejects reusing an old successful bundle for later raw facts", async () => {
    const content = await createPost("runtime-old-bundle", runtimeActorId);
    const revisionId = randomUUID();
    const idempotencyId = randomUUID();

    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, {
        id: idempotencyId,
        key: `runtime-old-bundle-${content.contentId}`,
        operation: "update_content",
      });
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
          ${content.contentId},
          2,
          'Successful Runtime bundle',
          'A committed provenance bundle cannot authorize later fact writes.',
          'A committed provenance bundle cannot authorize later fact writes.',
          ${runtimeActorId},
          2,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set version = 2,
            current_revision_id = ${revisionId}
        where id = ${content.contentId} and version = 1
      `;
      await finishContentCommand(transaction, {
        action: "content.update_content",
        contentId: content.contentId,
        eventType: "content.revised",
        idempotencyId,
        operation: "update_content",
        payload: {
          actor_id: runtimeActorId,
          content_id: content.contentId,
          resource_version: 2,
          revision_id: revisionId,
        },
        resourceVersion: 2,
        revisionId,
        responseCode: 200,
      });
    });

    const sourceUrl = `https://example.test/old-bundle/${randomUUID()}`;
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.source_links (
            id,
            content_id,
            position,
            url,
            normalized_url_hash,
            added_revision_id,
            added_by_actor_id
          )
          values (
            ${randomUUID()},
            ${content.contentId},
            1,
            ${sourceUrl},
            ${createHash("sha256").update(sourceUrl).digest()},
            ${revisionId},
            ${runtimeActorId}
          )
        `;
      }),
    ).rejects.toThrow(/active transaction tree/u);

    const persisted = await postgres.sql<{ sources: number; version: number }[]>`
      select
        content.version::integer as version,
        count(source.id)::integer as sources
      from platform.content_items as content
      left join platform.source_links as source on source.content_id = content.id
      where content.id = ${content.contentId}
      group by content.id
    `;
    expect(persisted).toEqual([{ sources: 0, version: 2 }]);
  });

  it("keeps Content identity, primary Community, tree, and publish time immutable", async () => {
    const content = await createPost("immutable-identity");
    const parent = await createPost("alternate-parent");

    await expect(
      postgres.sql`
        update platform.content_items
        set author_actor_id = ${alternateActorId}, version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set primary_community_id = ${alternateCommunityId}, version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set kind = 'reply', version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set root_id = ${parent.contentId}, version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set parent_id = ${parent.contentId}, version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set depth = 1, version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_items
        set published_at = published_at + interval '1 second',
            version = version + 1
        where id = ${content.contentId}
      `,
    ).rejects.toThrow();

    const unchanged = await postgres.sql<
      {
        author_actor_id: string;
        current_revision_id: string;
        depth: number;
        kind: string;
        parent_id: string | null;
        primary_community_id: string;
        root_id: string;
        version: number;
      }[]
    >`
      select
        author_actor_id,
        current_revision_id,
        depth,
        kind,
        parent_id,
        primary_community_id,
        root_id,
        version::integer
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(unchanged).toEqual([
      {
        author_actor_id: authorActorId,
        current_revision_id: content.revisionId,
        depth: 0,
        kind: "post",
        parent_id: null,
        primary_community_id: primaryCommunityId,
        root_id: content.contentId,
        version: 1,
      },
    ]);
  });

  it("requires exact Revision and source-version sequences and rejects orphan commits", async () => {
    const content = await createPost("exact-sequence");
    const nonInitialContentId = randomUUID();

    await expect(
      postgres.sql.begin(async (transaction) => {
        await transaction`
          insert into platform.content_items (
            id,
            version,
            kind,
            author_actor_id,
            primary_community_id,
            root_id,
            depth
          )
          values (
            ${nonInitialContentId},
            2,
            'post',
            ${authorActorId},
            ${primaryCommunityId},
            ${nonInitialContentId},
            0
          )
        `;
        await transaction`
          insert into platform.content_revisions (
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
            ${nonInitialContentId},
            1,
            'Non-initial Content fixture',
            'New Content cannot begin at an arbitrary command version.',
            'New Content cannot begin at an arbitrary command version.',
            ${authorActorId},
            2,
            ${randomBytes(32)},
            512
          )
        `;
      }),
    ).rejects.toThrow();

    await expect(
      postgres.sql`
        insert into platform.content_revisions (
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
          ${content.contentId},
          2,
          'Revision sequence fixture',
          'A stale source version must be rejected.',
          'A stale source version must be rejected.',
          ${authorActorId},
          1,
          ${randomBytes(32)},
          512
        )
      `,
    ).rejects.toThrow();

    await expect(
      postgres.sql`
        insert into platform.content_revisions (
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
          ${content.contentId},
          3,
          'Revision sequence fixture',
          'A skipped Revision number must be rejected.',
          'A skipped Revision number must be rejected.',
          ${authorActorId},
          2,
          ${randomBytes(32)},
          512
        )
      `,
    ).rejects.toThrow();

    await expect(
      postgres.sql.begin(async (transaction) => {
        await transaction`
          insert into platform.content_revisions (
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
            ${content.contentId},
            2,
            'Revision orphan fixture',
            'This Revision is never selected by ContentItem.',
            'This Revision is never selected by ContentItem.',
            ${authorActorId},
            2,
            ${randomBytes(32)},
            512
          )
        `;
      }),
    ).rejects.toThrow();

    const state = await postgres.sql<{ revisions: number; version: number }[]>`
      select
        content.version::integer as version,
        count(revision.id)::integer as revisions
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.content_id = content.id
      where content.id = ${content.contentId}
      group by content.version
    `;
    expect(state).toEqual([{ revisions: 1, version: 1 }]);
  });

  it("rejects a new Revision after irreversible Content deletion", async () => {
    const content = await createPost("deleted-content");
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${content.contentId}
    `;

    await expect(
      postgres.sql`
        insert into platform.content_revisions (
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
          ${content.contentId},
          2,
          'Deleted content Revision',
          'Deleted content cannot receive another author Revision.',
          'Deleted content cannot receive another author Revision.',
          ${authorActorId},
          3,
          ${randomBytes(32)},
          512
        )
      `,
    ).rejects.toThrow();
  });

  it("closes source and reference facts only under the in-progress newest Revision", async () => {
    const content = await createPost("revision-window-source");
    const target = await createPost("revision-window-target");
    const sourceId = randomUUID();
    const relationId = randomUUID();
    const sourceUrl = `https://example.test/revision/${sourceId}`;
    await postgres.sql.begin(async (transaction) => {
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          added_revision_id,
          added_by_actor_id
        )
        values (
          ${sourceId},
          ${content.contentId},
          1,
          ${sourceUrl},
          ${createHash("sha256").update(sourceUrl).digest()},
          ${content.revisionId},
          ${authorActorId}
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
          ${content.contentId},
          ${target.contentId},
          1,
          'reference',
          ${content.revisionId}
        )
      `;
    });

    const secondRevisionId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
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
          ${secondRevisionId},
          ${content.contentId},
          2,
          'Revision window fixture',
          'The second Revision keeps both existing facts active.',
          'The second Revision keeps both existing facts active.',
          ${authorActorId},
          2,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set version = 2, current_revision_id = ${secondRevisionId}
        where id = ${content.contentId} and version = 1
      `;
    });

    await expect(
      postgres.sql`
        update platform.source_links
        set removed_revision_id = ${secondRevisionId}
        where id = ${sourceId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_relations
        set removed_revision_id = ${secondRevisionId}
        where id = ${relationId}
      `,
    ).rejects.toThrow();

    const thirdRevisionId = randomUUID();
    await postgres.sql.begin(async (transaction) => {
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
          ${thirdRevisionId},
          ${content.contentId},
          3,
          'Revision window fixture',
          'The third Revision removes the previous source and reference.',
          'The third Revision removes the previous source and reference.',
          ${authorActorId},
          3,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.source_links
        set removed_revision_id = ${thirdRevisionId}
        where id = ${sourceId} and removed_revision_id is null
      `;
      await transaction`
        update platform.content_relations
        set removed_revision_id = ${thirdRevisionId}
        where id = ${relationId} and removed_revision_id is null
      `;
      await transaction`
        update platform.content_items
        set version = 3, current_revision_id = ${thirdRevisionId}
        where id = ${content.contentId} and version = 2
      `;
    });

    await expect(
      postgres.sql`
        update platform.source_links
        set removed_revision_id = removed_revision_id
        where id = ${sourceId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.content_relations
        set removed_revision_id = removed_revision_id
        where id = ${relationId}
      `,
    ).rejects.toThrow();

    const closed = await postgres.sql<
      { relation_removed_revision_id: string; source_removed_revision_id: string }[]
    >`
      select
        source.removed_revision_id as source_removed_revision_id,
        relation.removed_revision_id as relation_removed_revision_id
      from platform.source_links as source
      join platform.content_relations as relation
        on relation.from_content_id = source.content_id
      where source.id = ${sourceId}
        and relation.id = ${relationId}
    `;
    expect(closed).toEqual([
      {
        relation_removed_revision_id: thirdRevisionId,
        source_removed_revision_id: thirdRevisionId,
      },
    ]);
  });
});
