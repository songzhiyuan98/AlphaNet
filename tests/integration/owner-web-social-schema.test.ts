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
  OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM,
  PostgresAgentConnectionService,
} from "../../packages/domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeOwnerWebSocial = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
type TransactionSql = Parameters<Parameters<PostgresClient["begin"]>[1]>[0];
type ContentOperation = "create_post" | "delete_content" | "update_content";

interface PrincipalFixture {
  actorId: string;
  actorKind: "agent" | "human";
  agentId: string | null;
  approvalMethod: "human_direct" | "owner_direct" | "policy_auto";
  approvedByOwnerId: string | null;
  authenticationAssurance: string;
  credentialId: string | null;
  ownerId: string;
  policyVersion: string | null;
  principalScopeKey: string;
}

interface PendingApprovalFixture {
  actionId: string;
  decisionAuditId: string;
  idempotencyId: string;
  leaseToken: Buffer;
}

interface ContentFixture {
  contentId: string;
  revisionId: string;
}

interface ActionLogInput {
  actorId: string;
  actorKind: "agent" | "human";
  agentId: string | null;
  approvalMethod:
    "human_direct" | "owner_approval" | "owner_direct" | "policy_auto" | null;
  approvedByOwnerId: string | null;
  authenticationAssurance: string | null;
  channel: string;
  credentialId: string | null;
  ownerId: string;
  policyVersion: string | null;
}

const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "owner-web-social-schema-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

function requireId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

function quoteRole(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) {
    throw new Error("Unsafe PostgreSQL role fixture name");
  }
  return `"${role}"`;
}

describeOwnerWebSocial("Owner/Human Web social database contract", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(
    postgres.sql,
    agentConnectionOptions,
  );
  dependencies.push(postgres);

  let runtimeRole = "";
  let primaryCommunityId = "";
  let ownerId = "";
  let humanActorId = "";
  let agentActorId = "";
  let agentId = "";
  let credentialId = "";
  let policyId = "";
  let policyVersion = "";
  let alternateAgentActorId = "";
  let alternateAgentId = "";
  let alternateCredentialId = "";
  let foreignOwnerId = "";
  let foreignHumanActorId = "";

  function ownerDirectPrincipal(): PrincipalFixture {
    return {
      actorId: agentActorId,
      actorKind: "agent",
      agentId,
      approvalMethod: "owner_direct",
      approvedByOwnerId: ownerId,
      authenticationAssurance: "owner_session",
      credentialId: null,
      ownerId,
      policyVersion,
      principalScopeKey: `owner_direct:${ownerId}:${agentId}`,
    };
  }

  function humanDirectPrincipal(): PrincipalFixture {
    return {
      actorId: humanActorId,
      actorKind: "human",
      agentId: null,
      approvalMethod: "human_direct",
      approvedByOwnerId: ownerId,
      authenticationAssurance: "owner_session",
      credentialId: null,
      ownerId,
      policyVersion: null,
      principalScopeKey: `human_web:${ownerId}:${humanActorId}`,
    };
  }

  function credentialPrincipal(): PrincipalFixture {
    return {
      actorId: agentActorId,
      actorKind: "agent",
      agentId,
      approvalMethod: "policy_auto",
      approvedByOwnerId: null,
      authenticationAssurance: "agent_credential",
      credentialId,
      ownerId,
      policyVersion,
      principalScopeKey: `credential:${credentialId}`,
    };
  }

  async function createOwnerWithHuman(label: string): Promise<{
    actorId: string;
    ownerId: string;
  }> {
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
        ${`Owner Web ${label}`},
        ${`owner-web-${label}-${userId.slice(0, 8)}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id from platform.owners where auth_user_id = ${userId}
    `;
    const createdOwnerId = requireId(owners[0]?.id, `${label} Owner`);
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
        ${createdOwnerId},
        ${`owner-web-${actorId.replaceAll("-", "").slice(0, 18)}`},
        ${`Owner Web ${label}`},
        'active'
      )
    `;
    return { actorId, ownerId: createdOwnerId };
  }

  async function asRuntime(
    work: (transaction: TransactionSql) => Promise<void>,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteRole(runtimeRole)}`);
      await transaction.savepoint("owner_web_social_bundle", work);
    });
  }

  async function insertInProgressIdempotency(
    transaction: TransactionSql,
    principal: PrincipalFixture,
    input: { id: string; key: string; operation: ContentOperation },
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
        ${principal.principalScopeKey},
        ${principal.ownerId},
        ${principal.agentId},
        ${principal.actorId},
        ${principal.credentialId},
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

  async function nextOutboxSequence(
    transaction: TransactionSql,
    aggregateId: string,
  ): Promise<number> {
    const rows = await transaction<{ next_sequence: number }[]>`
      select coalesce(
        (
          select head.last_sequence + 1
          from system.outbox_aggregate_heads as head
          where head.aggregate_type = 'content'
            and head.aggregate_id = ${aggregateId}
        ),
        1
      )::integer as next_sequence
    `;
    const sequence = rows[0]?.next_sequence;
    if (!sequence) throw new Error("Outbox sequence was not allocated");
    return sequence;
  }

  async function finishContentCommand(
    transaction: TransactionSql,
    principal: PrincipalFixture,
    input: {
      action: "content.create_post" | "content.delete_content" | "content.update_content";
      contentId: string;
      eventType: "content.deleted" | "content.published" | "content.revised";
      idempotencyId: string;
      operation: ContentOperation;
      payload: Parameters<TransactionSql["json"]>[0];
      resourceVersion: number;
      revisionId: string | null;
      responseCode: 200 | 201;
    },
  ): Promise<void> {
    const outboxId = randomUUID();
    const aggregateSequence = await nextOutboxSequence(transaction, input.contentId);
    await transaction`
      insert into system.outbox_events (
        id,
        aggregate_type,
        aggregate_id,
        aggregate_sequence,
        event_type,
        event_version,
        payload
      )
      values (
        ${outboxId},
        'content',
        ${input.contentId},
        ${aggregateSequence},
        ${input.eventType},
        1,
        ${transaction.json(input.payload)}
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
        ${principal.actorId},
        ${principal.actorKind},
        ${principal.ownerId},
        ${principal.agentId},
        ${principal.credentialId},
        ${principal.credentialId ? "rest" : "web"},
        ${principal.approvalMethod},
        ${principal.approvedByOwnerId},
        ${principal.authenticationAssurance},
        ${transaction.json({
          decision: "allow",
          principal: principal.approvalMethod,
        })},
        ${input.action},
        'content',
        ${input.contentId},
        'allow',
        'succeeded',
        ${outboxId},
        ${principal.policyVersion},
        ${`owner-web-social-${randomUUID()}`},
        ${transaction.json({
          content_id: input.contentId,
          idempotency_record_id: input.idempotencyId,
          ...(input.operation === "delete_content"
            ? { lifecycle_state: "deleted" }
            : { revision_id: input.revisionId }),
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
        and status = 'in_progress'
      returning id
    `;
    expect(finalized).toEqual([{ id: input.idempotencyId }]);
  }

  async function createBaseline(actorId: string, label: string): Promise<ContentFixture> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Owner Web baseline ${label} ${contentId}`;
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
          ${`Owner Web baseline ${label}`},
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
    });
    return { contentId, revisionId };
  }

  async function commitCreate(
    principal: PrincipalFixture,
    label: string,
  ): Promise<ContentFixture> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const idempotencyId = randomUUID();
    const body = `Owner Web create ${label} ${contentId}`;
    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, principal, {
        id: idempotencyId,
        key: `create-${label}-${contentId}`,
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
          ${principal.actorId},
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
          ${`Owner Web create ${label}`},
          ${body},
          ${body},
          ${principal.actorId},
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
      await finishContentCommand(transaction, principal, {
        action: "content.create_post",
        contentId,
        eventType: "content.published",
        idempotencyId,
        operation: "create_post",
        payload: {
          actor_id: principal.actorId,
          content_id: contentId,
          kind: "post",
          revision_id: revisionId,
        },
        resourceVersion: 1,
        revisionId,
        responseCode: 201,
      });
    });
    return { contentId, revisionId };
  }

  async function commitRevision(
    principal: PrincipalFixture,
    label: string,
  ): Promise<void> {
    const content = await createBaseline(principal.actorId, `${label}-revision`);
    const revisionId = randomUUID();
    const idempotencyId = randomUUID();
    const body = `Owner Web revision ${label} ${revisionId}`;
    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, principal, {
        id: idempotencyId,
        key: `revision-${label}-${content.contentId}`,
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
          ${`Owner Web revision ${label}`},
          ${body},
          ${body},
          'Exercise direct Web Revision provenance.',
          ${principal.actorId},
          2,
          ${randomBytes(32)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set version = 2, current_revision_id = ${revisionId}
        where id = ${content.contentId} and version = 1
      `;
      await finishContentCommand(transaction, principal, {
        action: "content.update_content",
        contentId: content.contentId,
        eventType: "content.revised",
        idempotencyId,
        operation: "update_content",
        payload: {
          actor_id: principal.actorId,
          content_id: content.contentId,
          resource_version: 2,
          revision_id: revisionId,
        },
        resourceVersion: 2,
        revisionId,
        responseCode: 200,
      });
    });
  }

  async function commitDelete(principal: PrincipalFixture, label: string): Promise<void> {
    const content = await createBaseline(principal.actorId, `${label}-delete`);
    const idempotencyId = randomUUID();
    await asRuntime(async (transaction) => {
      await insertInProgressIdempotency(transaction, principal, {
        id: idempotencyId,
        key: `delete-${label}-${content.contentId}`,
        operation: "delete_content",
      });
      await transaction`
        update platform.content_items
        set version = 2,
            lifecycle_state = 'deleted',
            deleted_at = clock_timestamp()
        where id = ${content.contentId} and version = 1
      `;
      await finishContentCommand(transaction, principal, {
        action: "content.delete_content",
        contentId: content.contentId,
        eventType: "content.deleted",
        idempotencyId,
        operation: "delete_content",
        payload: {
          actor_id: principal.actorId,
          content_id: content.contentId,
          current_revision_id: content.revisionId,
          kind: "post",
          lifecycle_state: "deleted",
          resource_version: 2,
          root_content_id: content.contentId,
        },
        resourceVersion: 2,
        revisionId: content.revisionId,
        responseCode: 200,
      });
    });
  }

  async function insertDeniedActionLog(input: ActionLogInput): Promise<string> {
    const requestId = `owner-web-shape-${randomUUID()}`;
    await postgres.sql`
      insert into platform.action_logs (
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
        error_code,
        policy_version,
        request_id,
        reason_code
      )
      values (
        'domain_write',
        ${input.actorId},
        ${input.actorKind},
        ${input.ownerId},
        ${input.agentId},
        ${input.credentialId},
        ${input.channel},
        ${input.approvalMethod},
        ${input.approvedByOwnerId},
        ${input.authenticationAssurance},
        '{"decision":"deny"}'::jsonb,
        'content.create_post',
        'community',
        ${primaryCommunityId},
        'deny',
        'denied',
        'POLICY_DENIED',
        ${input.policyVersion},
        ${requestId},
        'policy_denied'
      )
    `;
    return requestId;
  }

  async function createApprovedCreate(): Promise<PendingApprovalFixture> {
    const actionId = randomUUID();
    const requestAuditId = randomUUID();
    const decisionAuditId = randomUUID();
    const idempotencyId = randomUUID();
    const pendingOutboxId = randomUUID();
    const idempotencyKey = `approved-create-${randomUUID()}`;
    const requestDigest = createHash("sha256").update(idempotencyKey).digest();
    const leaseToken = randomBytes(32);
    const principal = credentialPrincipal();

    await postgres.sql.begin(async (transaction) => {
      await insertInProgressIdempotency(transaction, principal, {
        id: idempotencyId,
        key: idempotencyKey,
        operation: "create_post",
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
          ${agentActorId},
          'agent',
          ${ownerId},
          ${agentId},
          ${credentialId},
          'rest',
          '{"decision":"require_approval"}'::jsonb,
          'content.create_post',
          'community',
          ${primaryCommunityId},
          'require_approval',
          'pending',
          ${pendingOutboxId},
          ${policyVersion},
          ${`owner-web-pending-${randomUUID()}`},
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
          ${`credential:${credentialId}`},
          'create_post',
          'community',
          ${primaryCommunityId},
          ${randomBytes(48)},
          ${randomBytes(12)},
          1,
          ${requestDigest},
          ${idempotencyKey},
          ${idempotencyId},
          ${randomUUID()},
          ${policyId},
          ${policyVersion},
          '{"decision":"require_approval","layers":[]}'::jsonb,
          'Owner Web schema regression fixture.',
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
          ${ownerId},
          ${agentId},
          'owner_api',
          'owner_approval',
          ${ownerId},
          'owner_session',
          '{"owner_session":true}'::jsonb,
          'pending_action.approve',
          'pending_action',
          ${actionId},
          'require_approval',
          'succeeded',
          ${policyVersion},
          ${`owner-web-approve-${randomUUID()}`},
          'owner_approved'
        )
      `;
      await transaction`
        update platform.pending_actions
        set state = 'approved',
            version = version + 1,
            decided_at = clock_timestamp(),
            decided_by_owner_id = ${ownerId},
            approval_method = 'owner_approval',
            decision_reason_code = 'owner_approved',
            decision_audit_id = ${decisionAuditId}
        where id = ${actionId} and state = 'pending_approval'
      `;
      await transaction`
        update platform.pending_actions
        set state = 'executing',
            version = version + 1,
            executing_at = statement_timestamp(),
            lease_owner = 'owner-web-schema-worker',
            lease_token_digest = ${leaseToken},
            lease_expires_at = statement_timestamp() + interval '30 seconds',
            last_heartbeat_at = statement_timestamp(),
            attempt_count = attempt_count + 1,
            next_attempt_at = null
        where id = ${actionId} and state = 'approved'
      `;
    });
    return { actionId, decisionAuditId, idempotencyId, leaseToken };
  }

  async function commitApprovedCreate(): Promise<void> {
    const approved = await createApprovedCreate();
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const outboxId = randomUUID();
    const body = `Owner-approved schema regression ${contentId}`;
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
          ${agentActorId},
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
          'Owner-approved schema regression',
          ${body},
          ${body},
          ${agentActorId},
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
        insert into system.outbox_events (
          id,
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          event_version,
          payload
        )
        values (
          ${outboxId},
          'content',
          ${contentId},
          1,
          'content.published',
          1,
          ${transaction.json({
            actor_id: agentActorId,
            content_id: contentId,
            kind: "post",
            revision_id: revisionId,
          })}
        )
      `;
      const completed = await transaction<{ id: string }[]>`
        update platform.pending_actions
        set state = 'succeeded',
            version = version + 1,
            result = ${transaction.json({
              content_id: contentId,
              resource_version: 1,
              revision_id: revisionId,
            })}
        where id = ${approved.actionId}
          and state = 'executing'
          and attempt_count = 1
          and lease_owner = 'owner-web-schema-worker'
          and lease_token_digest = ${approved.leaseToken}
          and lease_expires_at > clock_timestamp()
        returning id
      `;
      expect(completed).toEqual([{ id: approved.actionId }]);
      await transaction`
        insert into platform.action_logs (
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
          'domain_write',
          ${agentActorId},
          'agent',
          ${ownerId},
          ${agentId},
          ${credentialId},
          'worker',
          'owner_approval',
          ${ownerId},
          'owner_approval_record',
          ${transaction.json({
            decision: "require_approval",
            owner_approval: {
              decision_audit_id: approved.decisionAuditId,
              method: "owner_approval",
            },
          })},
          'content.create_post',
          'content',
          ${contentId},
          'require_approval',
          'succeeded',
          ${outboxId},
          ${policyVersion},
          ${`owner-web-approved-execution-${randomUUID()}`},
          ${transaction.json({
            content_id: contentId,
            idempotency_record_id: approved.idempotencyId,
            pending_action_id: approved.actionId,
            resource_version: 1,
            revision_id: revisionId,
          })}
        )
      `;
      await transaction`
        update platform.idempotency_records
        set status = 'succeeded',
            response_code = 201,
            response_body = '{"operation":"create_post","status":"succeeded"}'::jsonb,
            resource_id = ${contentId},
            terminal_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where id = ${approved.idempotencyId}
          and status = 'pending_approval'
      `;
    });
  }

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 8);
    const owner = await createOwnerWithHuman(`${marker}-primary`);
    ownerId = owner.ownerId;
    humanActorId = owner.actorId;
    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: "Owner Web Primary Agent",
        handle: `owner-web-primary-${marker}`,
      },
      randomUUID(),
    );
    agentId = created.agent.id;
    agentActorId = created.agent.actorId;
    policyId = created.agent.policy.id;
    policyVersion = created.agent.policy.version;
    const credential = await agentService.createCredential(
      ownerId,
      agentId,
      {
        name: "Owner Web primary schema credential",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    credentialId = credential.credential.id;

    const alternate = await agentService.createAgent(
      ownerId,
      {
        displayName: "Owner Web Alternate Agent",
        handle: `owner-web-alternate-${marker}`,
      },
      randomUUID(),
    );
    alternateAgentId = alternate.agent.id;
    alternateAgentActorId = alternate.agent.actorId;
    const alternateCredential = await agentService.createCredential(
      ownerId,
      alternateAgentId,
      {
        name: "Owner Web alternate schema credential",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    alternateCredentialId = alternateCredential.credential.id;

    const foreign = await createOwnerWithHuman(`${marker}-foreign`);
    foreignOwnerId = foreign.ownerId;
    foreignHumanActorId = foreign.actorId;
    primaryCommunityId = randomUUID();
    await postgres.sql`
      insert into platform.communities (
        id,
        slug,
        name,
        description,
        kind
      )
      values (
        ${primaryCommunityId},
        ${`owner-web-social-${marker}`},
        'Owner Web Social Schema',
        'Community for Owner/Human Web provenance tests.',
        'general'
      )
    `;

    runtimeRole = `alphanet_owner_web_rt_${marker}`;
    const currentRoles = await postgres.sql<{ current_user: string }[]>`
      select current_user
    `;
    const testOwnerRole = requireId(currentRoles[0]?.current_user, "test role");
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
        platform.content_items,
        platform.content_revisions,
        platform.idempotency_records,
        system.outbox_aggregate_heads,
        system.outbox_events
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
      grant update on table
        platform.idempotency_records,
        platform.pending_actions,
        system.outbox_aggregate_heads
      to ${quoteRole(runtimeRole)}
    `);
    await postgres.sql.unsafe(`
      grant execute on function
        platform.audit_json_is_secret_free(jsonb),
        platform.audit_json_is_secret_free_v2(jsonb)
      to ${quoteRole(runtimeRole)}
    `);
  });

  afterAll(async () => {
    if (runtimeRole) {
      const currentRoles = await postgres.sql<{ current_user: string }[]>`
        select current_user
      `;
      const testOwnerRole = requireId(currentRoles[0]?.current_user, "test role");
      await postgres.sql.unsafe(`drop owned by ${quoteRole(runtimeRole)}`);
      await postgres.sql.unsafe(
        `revoke ${quoteRole(runtimeRole)} from ${quoteRole(testOwnerRole)}`,
      );
      await postgres.sql.unsafe(`drop role ${quoteRole(runtimeRole)}`);
    }
    await closeDependencies(dependencies);
  });

  it("pins migration 000021 and installs the closed principal guard", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000021_owner_web_social_v1.up.sql`,
    );
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(checksum).toBe(OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM);

    const rows = await postgres.sql<
      {
        checksum: string;
        function_installed: boolean;
        function_security_definer: boolean;
        runtime_can_execute: boolean;
        search_path_closed: boolean;
        trigger_installed: boolean;
      }[]
    >`
      select
        migration.checksum,
        to_regprocedure(
          'platform.validate_domain_write_subject()'
        ) is not null as function_installed,
        routine.prosecdef as function_security_definer,
        'search_path=pg_catalog' = any(routine.proconfig) as search_path_closed,
        has_function_privilege(
          ${runtimeRole},
          routine.oid,
          'EXECUTE'
        ) as runtime_can_execute,
        exists (
          select 1
          from pg_catalog.pg_trigger as trigger
          where trigger.tgrelid = 'platform.action_logs'::regclass
            and trigger.tgname = 'action_logs_validate_domain_write_subject'
            and trigger.tgfoid =
              'platform.validate_domain_write_subject()'::regprocedure
        ) as trigger_installed
      from system.schema_migrations as migration
      cross join pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
       and namespace.nspname = 'platform'
      where routine.proname = 'validate_domain_write_subject'
        and routine.pronargs = 0
        and migration.version = '000021'
    `;
    expect(rows).toEqual([
      {
        checksum: OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM,
        function_installed: true,
        function_security_definer: true,
        runtime_can_execute: false,
        search_path_closed: true,
        trigger_installed: true,
      },
    ]);
  });

  it("accepts the credential, owner-direct Agent, and human-direct shapes", async () => {
    const requests = await Promise.all([
      insertDeniedActionLog({
        actorId: agentActorId,
        actorKind: "agent",
        agentId,
        approvalMethod: "policy_auto",
        approvedByOwnerId: null,
        authenticationAssurance: "agent_credential",
        channel: "rest",
        credentialId,
        ownerId,
        policyVersion,
      }),
      insertDeniedActionLog({
        actorId: agentActorId,
        actorKind: "agent",
        agentId,
        approvalMethod: "owner_direct",
        approvedByOwnerId: ownerId,
        authenticationAssurance: "owner_session",
        channel: "web",
        credentialId: null,
        ownerId,
        policyVersion,
      }),
      insertDeniedActionLog({
        actorId: humanActorId,
        actorKind: "human",
        agentId: null,
        approvalMethod: "human_direct",
        approvedByOwnerId: ownerId,
        authenticationAssurance: "owner_session",
        channel: "web",
        credentialId: null,
        ownerId,
        policyVersion: null,
      }),
    ]);
    const rows = await postgres.sql<{ request_id: string }[]>`
      select request_id
      from platform.action_logs
      where request_id in ${postgres.sql(requests)}
    `;
    expect(rows).toHaveLength(3);
  });

  it("rejects every cross-principal and cross-identity forgery", async () => {
    const credentialShape: ActionLogInput = {
      actorId: agentActorId,
      actorKind: "agent",
      agentId,
      approvalMethod: "policy_auto",
      approvedByOwnerId: null,
      authenticationAssurance: "agent_credential",
      channel: "rest",
      credentialId,
      ownerId,
      policyVersion,
    };
    const ownerDirectShape: ActionLogInput = {
      ...credentialShape,
      approvalMethod: "owner_direct",
      approvedByOwnerId: ownerId,
      authenticationAssurance: "owner_session",
      channel: "web",
      credentialId: null,
    };
    const humanDirectShape: ActionLogInput = {
      ...ownerDirectShape,
      actorId: humanActorId,
      actorKind: "human",
      agentId: null,
      approvalMethod: "human_direct",
      policyVersion: null,
    };
    const forgeries: Array<[string, ActionLogInput]> = [
      [
        "credential authority with an Owner-direct approval",
        { ...credentialShape, approvalMethod: "owner_direct" },
      ],
      ["Owner-direct authority with a Credential", { ...ownerDirectShape, credentialId }],
      [
        "Owner-direct authority without Agent policy",
        { ...ownerDirectShape, policyVersion: null },
      ],
      ["Owner-direct authority outside Web", { ...ownerDirectShape, channel: "rest" }],
      [
        "Owner-direct authority without its approving Owner",
        { ...ownerDirectShape, approvedByOwnerId: null },
      ],
      [
        "Owner-direct authority without session assurance",
        { ...ownerDirectShape, authenticationAssurance: null },
      ],
      [
        "Owner-direct authority with a different managed Agent Actor",
        { ...ownerDirectShape, actorId: alternateAgentActorId },
      ],
      [
        "Owner-direct authority with a human Actor",
        { ...ownerDirectShape, actorId: humanActorId, actorKind: "human" },
      ],
      [
        "human-direct authority with an Agent",
        { ...humanDirectShape, agentId, policyVersion },
      ],
      [
        "human-direct authority with an Agent Actor",
        {
          ...humanDirectShape,
          actorId: agentActorId,
          actorKind: "agent",
        },
      ],
      ["human-direct authority outside Web", { ...humanDirectShape, channel: "rest" }],
      [
        "human-direct authority with Agent policy",
        { ...humanDirectShape, policyVersion },
      ],
      [
        "human-direct authority with a foreign Owner Actor",
        { ...humanDirectShape, actorId: foreignHumanActorId, ownerId },
      ],
      [
        "credential authority with the other Agent's Credential",
        { ...credentialShape, credentialId: alternateCredentialId },
      ],
      [
        "credential authority with the other Agent's ID",
        { ...credentialShape, agentId: alternateAgentId },
      ],
      [
        "credential authority with a foreign Owner",
        { ...credentialShape, ownerId: foreignOwnerId },
      ],
    ];

    for (const [label, forged] of forgeries) {
      await expect(insertDeniedActionLog(forged), label).rejects.toThrow();
    }
  });

  for (const [label, principal] of [
    ["owner_direct", ownerDirectPrincipal],
    ["human_direct", humanDirectPrincipal],
  ] as const) {
    it(`${label} commits create, Revision, and delete provenance bundles`, async () => {
      const current = principal();
      await expect(commitCreate(current, label)).resolves.toBeDefined();
      await expect(commitRevision(current, label)).resolves.toBeUndefined();
      await expect(commitDelete(current, label)).resolves.toBeUndefined();
    });
  }

  it("retains the credential-autonomous content provenance path", async () => {
    await expect(
      commitCreate(credentialPrincipal(), "credential-regression"),
    ).resolves.toBeDefined();
  });

  it("retains the PendingAction Owner-approval content provenance path", async () => {
    await expect(commitApprovedCreate()).resolves.toBeUndefined();
  });
});
