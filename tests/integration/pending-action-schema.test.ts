import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM,
  PostgresAgentConnectionService,
} from "../../packages/domain/src/index.js";
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

const describePendingActionSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentConnectionOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: {
    1: "pending-action-schema-pepper-with-more-than-thirty-two-characters",
  },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

const invalidatedError = {
  code: "ACTION_INVALIDATED",
  message: "The frozen action is no longer valid.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

const rejectedError = {
  code: "ACTION_REJECTED",
  message: "The Owner rejected this action.",
  retryable: false,
  details: null,
  retry_after_ms: null,
} as const;

interface PendingFixture {
  actionId: string;
  auditId: string;
  idempotencyId: string;
}

describePendingActionSchema("PendingAction execution schema", () => {
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
  let policyId = "";
  let policyVersion = "";

  beforeAll(async () => {
    const marker = randomUUID().replaceAll("-", "").slice(0, 10);
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        'PendingAction Schema Owner',
        ${`pending-action-schema-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id
    `;
    const authUserId = users[0]?.id;
    if (!authUserId) {
      throw new Error("PendingAction schema Owner was not inserted");
    }

    const owners = await postgres.sql<{ id: string }[]>`
      select id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    ownerId = owners[0]?.id ?? "";
    if (!ownerId) {
      throw new Error("PendingAction schema Owner projection was not created");
    }

    const created = await agentService.createAgent(
      ownerId,
      {
        displayName: "PendingAction Schema Agent",
        handle: `pending-schema-${marker}`,
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
        name: "PendingAction schema tests",
        scopes: ["research:read", "content:write", "actions:read"],
      },
      randomUUID(),
    );
    credentialId = credential.credential.id;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  async function createPendingAction(
    options: {
      legacyResourceId?: boolean;
    } = {},
  ): Promise<PendingFixture> {
    const actionId = randomUUID();
    const auditId = randomUUID();
    const idempotencyId = randomUUID();
    const outboxId = randomUUID();
    const idempotencyKey = `pending-schema-${randomUUID()}`;
    const requestDigest = randomBytes(32);
    const principalScopeKey = `credential:${credentialId}`;

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
          ${idempotencyId},
          ${principalScopeKey},
          ${ownerId},
          ${agentId},
          ${actorId},
          ${credentialId},
          'create_post',
          ${idempotencyKey},
          ${requestDigest},
          'in_progress',
          clock_timestamp() + interval '8 days'
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
          ${outboxId},
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
          reason_code
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
          'agent_credential',
          '{"scope":"content:write"}'::jsonb,
          'content.create_post',
          'pending_action',
          ${actionId},
          'require_approval',
          'pending',
          ${outboxId},
          ${policyVersion},
          ${`req-${randomUUID()}`},
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
          ${principalScopeKey},
          'create_post',
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
          'Create one post after Owner approval.',
          clock_timestamp() + interval '1 day',
          ${auditId}
        )
      `;

      await transaction`
        update platform.idempotency_records
        set status = 'pending_approval',
            response_code = 202,
            response_body = '{"status":"pending_approval"}'::jsonb,
            resource_id = ${options.legacyResourceId === false ? null : actionId}
        where id = ${idempotencyId}
      `;
    });

    return { actionId, auditId, idempotencyId };
  }

  async function createDecisionAudit(
    actionId: string,
    reasonCode: string,
    action = "pending_action.approve",
  ): Promise<string> {
    const auditId = randomUUID();
    await postgres.sql`
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
        ${auditId},
        'approval_transition',
        ${ownerId},
        ${agentId},
        'owner_api',
        'owner_approval',
        ${ownerId},
        'owner_session',
        '{"owner_session":true}'::jsonb,
        ${action},
        'pending_action',
        ${actionId},
        'require_approval',
        'succeeded',
        ${policyVersion},
        ${`req-${randomUUID()}`},
        ${reasonCode}
      )
    `;
    return auditId;
  }

  async function approve(actionId: string): Promise<void> {
    const decisionAuditId = await createDecisionAudit(actionId, "owner_approved");
    const rows = await postgres.sql<{ id: string }[]>`
      update platform.pending_actions
      set state = 'approved',
          version = version + 1,
          decided_at = clock_timestamp(),
          decided_by_owner_id = ${ownerId},
          approval_method = 'owner_approval',
          decision_reason_code = 'owner_approved',
          decision_audit_id = ${decisionAuditId}
      where id = ${actionId}
        and state = 'pending_approval'
      returning id
    `;
    expect(rows).toEqual([{ id: actionId }]);
  }

  async function claim(
    actionId: string,
    tokenDigest: Buffer,
    leaseInterval = "30 seconds",
  ): Promise<void> {
    const rows = await postgres.sql<{ id: string }[]>`
      update platform.pending_actions
      set state = 'executing',
          version = version + 1,
          executing_at = statement_timestamp(),
          lease_owner = 'pending-action-schema-worker',
          lease_token_digest = ${tokenDigest},
          lease_expires_at = statement_timestamp() + ${leaseInterval}::interval,
          last_heartbeat_at = statement_timestamp(),
          attempt_count = attempt_count + 1,
          next_attempt_at = null
      where id = ${actionId}
        and state = 'approved'
      returning id
    `;
    expect(rows).toEqual([{ id: actionId }]);
  }

  it("installs the append-only execution ledger, constraints, triggers and indexes", async () => {
    const readiness = await postgres.sql<
      {
        decision_reason: boolean;
        migration: boolean;
        objects: boolean;
      }[]
    >`
      select
        exists (
          select 1
          from system.schema_migrations
          where version = '000007'
            and name = 'pending_action_execution'
            and checksum = ${PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM}
        ) as migration,
        to_regclass('platform.pending_action_attempts') is not null
          and to_regclass('platform.pending_actions_approved_due_idx') is not null
          and to_regclass('platform.pending_actions_approval_expiry_idx') is not null
          and to_regclass('platform.pending_actions_lease_reaper_idx') is not null
          and to_regclass('platform.idempotency_records_pending_action_idx') is not null
          and exists (
            select 1
            from pg_trigger
            where tgrelid = 'platform.pending_actions'::regclass
              and tgname = 'pending_actions_sync_attempt'
              and not tgisinternal
          )
          and exists (
            select 1
            from information_schema.columns
            where table_schema = 'platform'
              and table_name = 'pending_actions'
              and column_name = 'failure_count'
          ) as objects,
        exists (
          select 1
          from information_schema.columns
          where table_schema = 'platform'
            and table_name = 'pending_actions'
            and column_name = 'decision_reason_code'
        ) as decision_reason
    `;
    expect(readiness).toEqual([
      { decision_reason: true, migration: true, objects: true },
    ]);

    const validTransitionAudit = await postgres.sql<{ id: string }[]>`
      insert into platform.action_logs (
        event_class,
        owner_id,
        agent_id,
        channel,
        action,
        target_type,
        target_id,
        decision,
        outcome,
        request_id,
        reason_code
      )
      values (
        'pending_action_transition',
        ${ownerId},
        ${agentId},
        'worker',
        'pending_action.claimed',
        'pending_action',
        ${randomUUID()},
        'require_approval',
        'pending',
        ${`worker-${randomUUID()}`},
        'worker_claimed'
      )
      returning id
    `;
    expect(validTransitionAudit).toHaveLength(1);

    await expect(
      postgres.sql`
        insert into platform.action_logs (
          event_class,
          channel,
          action,
          decision,
          outcome,
          request_id,
          reason_code
        )
        values (
          'pending_action_transition',
          'worker',
          'pending_action.claimed',
          'require_approval',
          'pending',
          ${`worker-invalid-${randomUUID()}`},
          'worker_claimed'
        )
      `,
    ).rejects.toThrow();
  });

  it("links idempotency to the action and validates immutable Owner decision evidence", async () => {
    const fixture = await createPendingAction();
    const linked = await postgres.sql<
      { pending_action_id: string; resource_id: string; status: string }[]
    >`
      select pending_action_id, resource_id, status
      from platform.idempotency_records
      where id = ${fixture.idempotencyId}
    `;
    expect(linked).toEqual([
      {
        pending_action_id: fixture.actionId,
        resource_id: fixture.actionId,
        status: "pending_approval",
      },
    ]);

    const mismatchedAuditId = await createDecisionAudit(
      fixture.actionId,
      "owner_rejected",
    );
    await expect(
      postgres.sql.begin(async (transaction) => {
        await transaction`
          update platform.pending_actions
          set state = 'approved',
              version = version + 1,
              decided_at = clock_timestamp(),
              decided_by_owner_id = ${ownerId},
              approval_method = 'owner_approval',
              decision_reason_code = 'owner_approved',
              decision_audit_id = ${mismatchedAuditId}
          where id = ${fixture.actionId}
        `;
      }),
    ).rejects.toThrow();

    await expect(
      postgres.sql`
        update platform.pending_actions
        set state = 'rejected',
            version = version + 1,
            decided_at = clock_timestamp(),
            decided_by_owner_id = ${ownerId},
            approval_method = 'owner_approval',
            decision_reason_code = 'free_form_owner_text',
            error = jsonb_build_object(
              'code', 'ACTION_REJECTED',
              'message', 'The Owner rejected this action.',
              'retryable', false,
              'details', null,
              'retry_after_ms', null
            )
        where id = ${fixture.actionId}
      `,
    ).rejects.toThrow();

    await approve(fixture.actionId);
    const approved = await postgres.sql<
      {
        decision_audit_id: string;
        decision_reason_code: string;
        next_attempt_at: Date;
        state: string;
      }[]
    >`
      select state, next_attempt_at, decision_audit_id, decision_reason_code
      from platform.pending_actions
      where id = ${fixture.actionId}
    `;
    expect(approved[0]?.state).toBe("approved");
    expect(approved[0]?.next_attempt_at).toBeInstanceOf(Date);
    expect(approved[0]?.decision_audit_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(approved[0]?.decision_reason_code).toBe("owner_approved");

    await expect(
      postgres.sql`
        update platform.pending_actions
        set version = version + 1,
            decision_reason_code = 'risk_not_accepted'
        where id = ${fixture.actionId}
      `,
    ).rejects.toThrow();
  });

  it("separates capacity deferrals from failed attempts while preserving every fence", async () => {
    const fixture = await createPendingAction();
    await approve(fixture.actionId);
    const firstToken = randomBytes(32);
    await claim(fixture.actionId, firstToken);

    await postgres.sql`
      update platform.pending_actions
      set version = version + 1,
          last_heartbeat_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + interval '30 seconds'
      where id = ${fixture.actionId}
        and state = 'executing'
        and attempt_count = 1
        and lease_owner = 'pending-action-schema-worker'
        and lease_token_digest = ${firstToken}
        and lease_expires_at > clock_timestamp()
    `;

    await expect(
      postgres.sql`
        update platform.pending_actions
        set version = version + 1,
            lease_token_digest = ${randomBytes(32)},
            last_heartbeat_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + interval '30 seconds'
        where id = ${fixture.actionId}
      `,
    ).rejects.toThrow();

    await postgres.sql`
      update platform.pending_actions
      set state = 'approved',
          version = version + 1,
          next_attempt_at = clock_timestamp()
      where id = ${fixture.actionId}
        and state = 'executing'
        and attempt_count = 1
        and lease_owner = 'pending-action-schema-worker'
        and lease_token_digest = ${firstToken}
        and lease_expires_at > clock_timestamp()
    `;

    const recovered = await postgres.sql<
      {
        attempt_count: number;
        executing_at: Date | null;
        failure_count: number;
        last_heartbeat_at: Date | null;
        lease_owner: string | null;
        outcome: string;
        state: string;
      }[]
    >`
      select
        action.state,
        action.attempt_count,
        action.failure_count,
        action.executing_at,
        action.lease_owner,
        action.last_heartbeat_at,
        attempt.outcome
      from platform.pending_actions as action
      join platform.pending_action_attempts as attempt
        on attempt.action_id = action.id
       and attempt.attempt_number = 1
      where action.id = ${fixture.actionId}
    `;
    expect(recovered).toEqual([
      {
        attempt_count: 1,
        executing_at: null,
        failure_count: 0,
        last_heartbeat_at: null,
        lease_owner: null,
        outcome: "deferred",
        state: "approved",
      },
    ]);

    const secondToken = randomBytes(32);
    await claim(fixture.actionId, secondToken);
    const stale = await postgres.sql<{ id: string }[]>`
      update platform.pending_actions
      set version = version + 1,
          last_heartbeat_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + interval '30 seconds'
      where id = ${fixture.actionId}
        and state = 'executing'
        and attempt_count = 1
        and lease_token_digest = ${firstToken}
      returning id
    `;
    expect(stale).toEqual([]);

    await postgres.sql`
      update platform.pending_actions
      set state = 'approved',
          version = version + 1,
          failure_count = failure_count + 1,
          next_attempt_at = clock_timestamp()
      where id = ${fixture.actionId}
        and state = 'executing'
        and attempt_count = 2
        and lease_owner = 'pending-action-schema-worker'
        and lease_token_digest = ${secondToken}
        and lease_expires_at > clock_timestamp()
    `;

    const thirdToken = randomBytes(32);
    await claim(fixture.actionId, thirdToken);

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.pending_actions
        set state = 'invalidated',
            version = version + 1,
            error = ${transaction.json(invalidatedError)}
        where id = ${fixture.actionId}
          and state = 'executing'
          and attempt_count = 3
          and lease_owner = 'pending-action-schema-worker'
          and lease_token_digest = ${thirdToken}
          and lease_expires_at > clock_timestamp()
      `;
      await transaction`
        update platform.idempotency_records
        set status = 'failed',
            response_code = 409,
            response_body = '{"status":"failed"}'::jsonb,
            resource_id = null,
            terminal_at = clock_timestamp(),
            expires_at = greatest(
              expires_at,
              clock_timestamp() + interval '7 days'
            )
        where id = ${fixture.idempotencyId}
          and status = 'pending_approval'
      `;
    });

    const attempts = await postgres.sql<
      { attempt_number: number; error_code: string | null; outcome: string }[]
    >`
      select attempt_number, outcome, error_code
      from platform.pending_action_attempts
      where action_id = ${fixture.actionId}
      order by attempt_number
    `;
    expect(attempts).toEqual([
      { attempt_number: 1, error_code: null, outcome: "deferred" },
      { attempt_number: 2, error_code: null, outcome: "retry_scheduled" },
      {
        attempt_number: 3,
        error_code: "ACTION_INVALIDATED",
        outcome: "invalidated",
      },
    ]);

    const terminal = await postgres.sql<
      { pending_action_id: string; resource_id: string | null; status: string }[]
    >`
      select pending_action_id, resource_id, status
      from platform.idempotency_records
      where id = ${fixture.idempotencyId}
    `;
    expect(terminal).toEqual([
      {
        pending_action_id: fixture.actionId,
        resource_id: null,
        status: "failed",
      },
    ]);
  });

  it("accepts only controlled rejection reasons and closes idempotency atomically", async () => {
    const fixture = await createPendingAction();
    const decisionAuditId = await createDecisionAudit(
      fixture.actionId,
      "needs_revision",
      "pending_action.reject",
    );

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.pending_actions
        set state = 'rejected',
            version = version + 1,
            decided_at = clock_timestamp(),
            decided_by_owner_id = ${ownerId},
            approval_method = 'owner_approval',
            decision_reason_code = 'needs_revision',
            decision_audit_id = ${decisionAuditId},
            error = ${transaction.json(rejectedError)}
        where id = ${fixture.actionId}
          and state = 'pending_approval'
      `;
      await transaction`
        update platform.idempotency_records
        set status = 'denied',
            response_code = 403,
            response_body = '{"status":"denied"}'::jsonb,
            resource_id = null,
            terminal_at = clock_timestamp(),
            expires_at = greatest(
              expires_at,
              clock_timestamp() + interval '7 days'
            )
        where id = ${fixture.idempotencyId}
          and status = 'pending_approval'
      `;
    });

    const rejected = await postgres.sql<
      {
        action_state: string;
        decision_reason_code: string;
        idempotency_status: string;
      }[]
    >`
      select
        action.state as action_state,
        action.decision_reason_code,
        idempotency.status as idempotency_status
      from platform.pending_actions as action
      join platform.idempotency_records as idempotency
        on idempotency.id = action.idempotency_record_id
      where action.id = ${fixture.actionId}
    `;
    expect(rejected).toEqual([
      {
        action_state: "rejected",
        decision_reason_code: "needs_revision",
        idempotency_status: "denied",
      },
    ]);
  });

  it("normalizes the legacy action resource to the final content exactly once", async () => {
    const fixture = await createPendingAction();
    await approve(fixture.actionId);
    const token = randomBytes(32);
    await claim(fixture.actionId, token);
    const contentId = randomUUID();
    const revisionId = randomUUID();

    await postgres.sql.begin(async (transaction) => {
      await transaction`
        update platform.pending_actions
        set state = 'succeeded',
            version = version + 1,
            result = ${transaction.json({
              content_id: contentId,
              revision_id: revisionId,
              resource_version: 1,
            })}
        where id = ${fixture.actionId}
          and state = 'executing'
          and attempt_count = 1
          and lease_owner = 'pending-action-schema-worker'
          and lease_token_digest = ${token}
          and lease_expires_at > clock_timestamp()
      `;
      await transaction`
        update platform.idempotency_records
        set status = 'succeeded',
            response_code = 201,
            response_body = ${transaction.json({
              content_id: contentId,
              status: "succeeded",
            })},
            resource_id = ${contentId},
            terminal_at = clock_timestamp(),
            expires_at = greatest(
              expires_at,
              clock_timestamp() + interval '7 days'
            )
        where id = ${fixture.idempotencyId}
          and status = 'pending_approval'
      `;
    });

    const result = await postgres.sql<
      {
        action_state: string;
        attempt_outcome: string;
        pending_action_id: string;
        resource_id: string;
        status: string;
      }[]
    >`
      select
        action.state as action_state,
        attempt.outcome as attempt_outcome,
        idempotency.status,
        idempotency.pending_action_id,
        idempotency.resource_id
      from platform.pending_actions as action
      join platform.pending_action_attempts as attempt
        on attempt.action_id = action.id
       and attempt.attempt_number = 1
      join platform.idempotency_records as idempotency
        on idempotency.id = action.idempotency_record_id
      where action.id = ${fixture.actionId}
    `;
    expect(result).toEqual([
      {
        action_state: "succeeded",
        attempt_outcome: "succeeded",
        pending_action_id: fixture.actionId,
        resource_id: contentId,
        status: "succeeded",
      },
    ]);

    await expect(
      postgres.sql`
        update platform.idempotency_records
        set resource_id = ${randomUUID()}
        where id = ${fixture.idempotencyId}
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        update platform.pending_actions
        set version = version + 1
        where id = ${fixture.actionId}
      `,
    ).rejects.toThrow();
  });
});
