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
  type AdminModerationContext,
  PostgresContentModerationService,
} from "../../packages/domain/src/content-moderation.js";
import { PostgresContentReportService } from "../../packages/domain/src/content-report.js";
import { WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM } from "../../packages/domain/src/schema-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeModerationSchema = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
type TransactionSql = Parameters<Parameters<PostgresClient["begin"]>[1]>[0];
type JsonValue = Parameters<TransactionSql["json"]>[0];
type TaggedQueryForwarder = (
  strings: TemplateStringsArray,
  ...parameters: readonly unknown[]
) => Promise<unknown>;

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

function roleScopedPostgres(sql: PostgresClient, role: string): PostgresClient {
  const roleSql = quoteRole(role);
  const scoped = (async (
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${roleSql}`);
      const forward = transaction as unknown as TaggedQueryForwarder;
      return forward(strings, ...parameters);
    })) as unknown as PostgresClient;
  scoped.begin = (async (callback: (transaction: TransactionSql) => Promise<unknown>) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${roleSql}`);
      return callback(transaction);
    })) as PostgresClient["begin"];
  return scoped;
}

interface ContentFixture {
  contentId: string;
  revisionId: string;
}

interface ReportFixture {
  caseId: string;
  reportId: string;
}

describeModerationSchema("Web reporting and Content moderation schema", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  const runtimeRole = `alphanet_mod_${marker}`;
  const runtimeSql = roleScopedPostgres(postgres.sql, runtimeRole);
  const runtimeReportService = new PostgresContentReportService(runtimeSql);
  const runtimeModerationService = new PostgresContentModerationService(runtimeSql, {
    cursorSigningKey: Buffer.alloc(32, 0x6d),
  });
  let adminId = "";
  let authorActorId = "";
  let communityId = "";
  let reporterActorId = "";
  let reporterOwnerId = "";
  let secondReporterActorId = "";
  let secondReporterOwnerId = "";

  async function createActor(
    label: string,
    kind: "agent" | "human" = "human",
  ): Promise<{
    actorId: string;
    ownerId: string;
  }> {
    const userId = randomUUID();
    const actorId = randomUUID();
    const agentId = randomUUID();
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
        ${`Moderation ${label}`},
        ${`moderation-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select id from platform.owners where auth_user_id = ${userId}
    `;
    const ownerId = requireId(owners[0]?.id, `${label} Owner`);
    await postgres.sql.begin(async (transaction) => {
      await transaction`
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
          ${kind},
          ${ownerId},
          ${`mod-${label}-${marker}`},
          ${`Moderation ${label}`},
          'active'
        )
      `;
      if (kind === "agent") {
        await transaction`
          insert into platform.agents (
            id,
            actor_id,
            owner_id,
            discovery_tags,
            status,
            activated_at
          )
          values (
            ${agentId},
            ${actorId},
            ${ownerId},
            array['moderation-test']::text[],
            'active',
            clock_timestamp()
          )
        `;
        await transaction`
          insert into platform.agent_policies (
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
            ${agentId},
            'assisted',
            'agent-permission-defaults-v1',
            1,
            1,
            ${transaction.json({})},
            true,
            ${ownerId}
          )
        `;
        await transaction`
          update platform.registration_controls
          set active_agent_count = active_agent_count + 1
          where id = true
        `;
      }
    });
    return { actorId, ownerId };
  }

  async function createContent(label: string): Promise<ContentFixture> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Moderation fixture ${label} ${contentId}`;
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
          ${authorActorId},
          ${communityId},
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
          ${`Moderation ${label}`},
          ${body},
          ${body},
          ${authorActorId},
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
      await transaction`
        insert into system.outbox_events (
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          payload
        )
        values (
          'content',
          ${contentId},
          1,
          'content.published',
          ${transaction.json({
            actor_id: authorActorId,
            content_id: contentId,
            kind: "post",
            revision_id: revisionId,
          })}
        )
      `;
    });
    return { contentId, revisionId };
  }

  async function createReply(
    root: ContentFixture,
    label: string,
  ): Promise<ContentFixture> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Moderation reply fixture ${label} ${contentId}`;
    await postgres.sql.begin(async (transaction) => {
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
          ${authorActorId},
          ${root.contentId},
          ${root.contentId},
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
          ${body},
          ${body},
          ${authorActorId},
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
      await transaction`
        insert into system.outbox_events (
          aggregate_type,
          aggregate_id,
          aggregate_sequence,
          event_type,
          payload
        )
        values (
          'content',
          ${contentId},
          1,
          'content.published',
          ${transaction.json({
            actor_id: authorActorId,
            content_id: contentId,
            kind: "reply",
            revision_id: revisionId,
            root_content_id: root.contentId,
          })}
        )
      `;
    });
    return { contentId, revisionId };
  }

  async function expectNoReportingRows(contentId: string): Promise<void> {
    const counts = await postgres.sql<{ cases: number; reports: number }[]>`
      select
        (
          select count(*)::integer
          from platform.reports
          where target_content_id = ${contentId}
        ) as reports,
        (
          select count(*)::integer
          from platform.moderation_cases
          where target_content_id = ${contentId}
        ) as cases
    `;
    expect(counts[0]).toEqual({ cases: 0, reports: 0 });
  }

  async function asRuntime(
    work: (transaction: TransactionSql) => Promise<void>,
  ): Promise<void> {
    await postgres.sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteRole(runtimeRole)}`);
      await work(transaction);
    });
  }

  async function createReport(
    contentId: string,
    options: {
      actorId?: string;
      description?: string | null;
      ownerId?: string;
      payloadOverride?: Record<string, unknown>;
      reasonCode?:
        | "harassment"
        | "impersonation"
        | "malicious_link"
        | "other_rule_violation"
        | "privacy_exposure"
        | "spam";
    } = {},
  ): Promise<ReportFixture> {
    const caseId = randomUUID();
    const reportId = randomUUID();
    const reasonCode = options.reasonCode ?? "spam";
    const actorId = options.actorId ?? reporterActorId;
    const ownerId = options.ownerId ?? reporterOwnerId;
    await asRuntime(async (transaction) => {
      await transaction`
        insert into platform.moderation_cases (
          id,
          target_type,
          target_content_id
        )
        values (${caseId}, 'content', ${contentId})
      `;
      const reportRows = await transaction<{ created_at: Date }[]>`
        insert into platform.reports (
          id,
          reporter_owner_id,
          reporter_actor_id,
          target_type,
          target_content_id,
          reason_code,
          description,
          authentication_assurance,
          idempotency_key,
          request_digest
        )
        values (
          ${reportId},
          ${ownerId},
          ${actorId},
          'content',
          ${contentId},
          ${reasonCode},
          ${options.description === undefined ? "private report detail" : options.description},
          'owner_session',
          ${`report-${reportId}`},
          ${createHash("sha256").update(reportId).digest()}
        )
        returning created_at
      `;
      const eventTime = reportRows[0]?.created_at;
      if (!eventTime) throw new Error("Report fixture has no database timestamp.");
      await transaction`
        insert into platform.moderation_case_items (case_id, report_id)
        values (${caseId}, ${reportId})
      `;
      await transaction`
        insert into platform.report_submission_idempotency (
          reporter_owner_id,
          reporter_actor_id,
          idempotency_key,
          request_digest,
          report_id
        )
        values (
          ${ownerId},
          ${actorId},
          ${`report-${reportId}`},
          ${createHash("sha256").update(reportId).digest()},
          ${reportId}
        )
      `;
      await transaction`
        insert into system.outbox_events (
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
          'report',
          ${reportId},
          1,
          'report.created',
          1,
          ${transaction.json(
            (options.payloadOverride ?? {
              case_id: caseId,
              content_id: contentId,
              reason_code: reasonCode,
              report_id: reportId,
            }) as JsonValue,
          )},
          ${eventTime},
          ${eventTime},
          12,
          ${eventTime}
        )
      `;
    });
    return { caseId, reportId };
  }

  async function moderateContent(
    content: ContentFixture,
    report: ReportFixture,
    options: {
      authorizationSnapshot?: {
        permission: string;
        permissions: string[];
        roles: string[];
      };
      eventPayloadPatch?: Record<string, unknown>;
      internalNote?: string;
    } = {},
  ): Promise<{ actionId: string; actionLogId: string; outboxEventId: string }> {
    const actionId = randomUUID();
    const actionLogId = randomUUID();
    const outboxEventId = randomUUID();
    const reasonCode = "confirmed_report_violation";
    const beforeState = { distribution_state: "normal", resource_version: 1 };
    const afterState = {
      case_id: report.caseId,
      content_id: content.contentId,
      distribution_state: "limited",
      moderation_action_id: actionId,
      resource_version: 2,
    };
    const payload = {
      after_distribution_state: "limited",
      before_distribution_state: "normal",
      case_id: report.caseId,
      content_id: content.contentId,
      current_revision_id: content.revisionId,
      kind: "post",
      moderation_action_id: actionId,
      reason_code: reasonCode,
      resource_version: 2,
      root_content_id: content.contentId,
      ...options.eventPayloadPatch,
    } satisfies Record<string, unknown>;

    await asRuntime(async (transaction) => {
      await transaction`
        update platform.content_items
        set version = 2,
            distribution_state = 'limited'
        where id = ${content.contentId}
          and version = 1
          and lifecycle_state = 'published'
      `;
      await transaction`
        update platform.reports
        set version = version + 1,
            status = 'resolved_action'
        where id = ${report.reportId}
          and status = 'open'
      `;
      const caseRows = await transaction<
        { closed_at: Date; updated_at: Date; version: number }[]
      >`
        update platform.moderation_cases
        set version = version + 1,
            status = 'resolved_action',
            assigned_admin_id = ${adminId},
            resolution_code = 'content_limited'
        where id = ${report.caseId}
          and status = 'open'
        returning version::integer as version, updated_at, closed_at
      `;
      const caseSnapshot = caseRows[0];
      if (!caseSnapshot?.closed_at || caseSnapshot.version !== 2) {
        throw new Error("Moderation test Case did not resolve.");
      }
      const eventTime = caseSnapshot.updated_at;
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
          ${outboxEventId},
          'content',
          ${content.contentId},
          2,
          'content.moderation_changed',
          1,
          ${transaction.json(payload)},
          ${eventTime},
          ${eventTime},
          12,
          ${eventTime}
        )
      `;
      await transaction`
        insert into platform.action_logs (
          id,
          event_class,
          occurred_at,
          admin_id,
          channel,
          approval_method,
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          outbox_event_id,
          request_id,
          before_state,
          after_state,
          reason_code
        )
        values (
          ${actionLogId},
          'governance',
          ${eventTime},
          ${adminId},
          'admin_web',
          'admin_override',
          'workforce_oidc',
          ${transaction.json(
            options.authorizationSnapshot ?? {
              permission: "moderation:decide",
              permissions: ["moderation:decide", "moderation:read"],
              roles: ["content_moderator"],
            },
          )},
          'moderation.limit_content',
          'content',
          ${content.contentId},
          'allow',
          'succeeded',
          ${outboxEventId},
          ${`moderation-${actionId}`},
          ${transaction.json(beforeState)},
          ${transaction.json(afterState)},
          ${reasonCode}
        )
      `;
      await transaction`
        insert into platform.moderation_actions (
          id,
          case_id,
          admin_id,
          permission_used,
          action,
          reason_code,
          internal_note,
          before_distribution_state,
          after_distribution_state,
          target_version_before,
          target_version_after,
          case_version_before,
          case_version_after,
          case_updated_at_after,
          case_closed_at_after,
          response_content_version,
          response_content_lifecycle_state,
          response_content_distribution_state,
          idempotency_key,
          request_digest,
          action_log_id,
          outbox_event_id
        )
        values (
          ${actionId},
          ${report.caseId},
          ${adminId},
          'moderation:decide',
          'limit_content',
          ${reasonCode},
          ${options.internalNote ?? "private moderator note"},
          'normal',
          'limited',
          1,
          2,
          1,
          2,
          (
            select updated_at
            from platform.moderation_cases
            where id = ${report.caseId}
          ),
          (
            select closed_at
            from platform.moderation_cases
            where id = ${report.caseId}
          ),
          2,
          'published',
          'limited',
          ${`moderation-${actionId}`},
          ${createHash("sha256").update(actionId).digest()},
          ${actionLogId},
          ${outboxEventId}
        )
      `;
    });
    return { actionId, actionLogId, outboxEventId };
  }

  async function restoreContent(
    content: ContentFixture,
    report: ReportFixture,
    revertsActionId: string,
  ): Promise<{ actionId: string; actionLogId: string; outboxEventId: string }> {
    const actionId = randomUUID();
    const actionLogId = randomUUID();
    const outboxEventId = randomUUID();
    const reasonCode = "risk_condition_resolved";
    const beforeState = { distribution_state: "limited", resource_version: 2 };
    const afterState = {
      case_id: report.caseId,
      content_id: content.contentId,
      distribution_state: "normal",
      moderation_action_id: actionId,
      resource_version: 3,
    };
    const payload = {
      after_distribution_state: "normal",
      before_distribution_state: "limited",
      case_id: report.caseId,
      content_id: content.contentId,
      current_revision_id: content.revisionId,
      kind: "post",
      moderation_action_id: actionId,
      reason_code: reasonCode,
      resource_version: 3,
      root_content_id: content.contentId,
    } satisfies Record<string, unknown>;

    await asRuntime(async (transaction) => {
      await transaction`
        update platform.content_items
        set version = 3,
            distribution_state = 'normal'
        where id = ${content.contentId}
          and version = 2
          and lifecycle_state = 'published'
          and distribution_state = 'limited'
      `;
      const caseRows = await transaction<
        { closed_at: Date; updated_at: Date; version: number }[]
      >`
        update platform.moderation_cases
        set version = version + 1,
            status = 'resolved_action',
            assigned_admin_id = ${adminId},
            resolution_code = 'content_restored'
        where id = ${report.caseId}
          and version = 2
          and status = 'resolved_action'
          and resolution_code = 'content_limited'
        returning version::integer as version, updated_at, closed_at
      `;
      const caseSnapshot = caseRows[0];
      if (!caseSnapshot?.closed_at || caseSnapshot.version !== 3) {
        throw new Error("Moderation test Case did not restore.");
      }
      const eventTime = caseSnapshot.updated_at;
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
          ${outboxEventId},
          'content',
          ${content.contentId},
          3,
          'content.moderation_changed',
          1,
          ${transaction.json(payload)},
          ${eventTime},
          ${eventTime},
          12,
          ${eventTime}
        )
      `;
      await transaction`
        insert into platform.action_logs (
          id,
          event_class,
          occurred_at,
          admin_id,
          channel,
          approval_method,
          authentication_assurance,
          authorization_snapshot,
          action,
          target_type,
          target_id,
          decision,
          outcome,
          outbox_event_id,
          request_id,
          before_state,
          after_state,
          reason_code
        )
        values (
          ${actionLogId},
          'governance',
          ${eventTime},
          ${adminId},
          'admin_web',
          'admin_override',
          'workforce_oidc',
          ${transaction.json({
            permission: "moderation:decide",
            permissions: ["moderation:decide", "moderation:read"],
            roles: ["content_moderator"],
          })},
          'moderation.restore_content',
          'content',
          ${content.contentId},
          'allow',
          'succeeded',
          ${outboxEventId},
          ${`moderation-${actionId}`},
          ${transaction.json(beforeState)},
          ${transaction.json(afterState)},
          ${reasonCode}
        )
      `;
      await transaction`
        insert into platform.moderation_actions (
          id,
          case_id,
          admin_id,
          permission_used,
          action,
          reason_code,
          internal_note,
          before_distribution_state,
          after_distribution_state,
          target_version_before,
          target_version_after,
          case_version_before,
          case_version_after,
          case_updated_at_after,
          case_closed_at_after,
          response_content_version,
          response_content_lifecycle_state,
          response_content_distribution_state,
          reverts_action_id,
          idempotency_key,
          request_digest,
          action_log_id,
          outbox_event_id
        )
        values (
          ${actionId},
          ${report.caseId},
          ${adminId},
          'moderation:decide',
          'restore_content',
          ${reasonCode},
          'private restoration analysis',
          'limited',
          'normal',
          2,
          3,
          2,
          3,
          (
            select updated_at
            from platform.moderation_cases
            where id = ${report.caseId}
          ),
          (
            select closed_at
            from platform.moderation_cases
            where id = ${report.caseId}
          ),
          3,
          'published',
          'normal',
          ${revertsActionId},
          ${`moderation-${actionId}`},
          ${createHash("sha256").update(actionId).digest()},
          ${actionLogId},
          ${outboxEventId}
        )
      `;
    });
    return { actionId, actionLogId, outboxEventId };
  }

  beforeAll(async () => {
    const author = await createActor("author");
    const reporter = await createActor("reporter", "agent");
    const secondReporter = await createActor("reporter-second", "agent");
    authorActorId = author.actorId;
    reporterActorId = reporter.actorId;
    reporterOwnerId = reporter.ownerId;
    secondReporterActorId = secondReporter.actorId;
    secondReporterOwnerId = secondReporter.ownerId;
    communityId = randomUUID();
    await postgres.sql`
      insert into platform.communities (
        id,
        slug,
        name,
        description,
        kind
      )
      values (
        ${communityId},
        ${`moderation-${marker}`},
        'Moderation schema fixture',
        'Temporary integration fixture.',
        'general'
      )
    `;

    const admins = await postgres.sql<{ id: string }[]>`
      insert into platform.admins (
        oidc_issuer,
        oidc_subject,
        display_name,
        status
      )
      values (
        'https://workforce.example.test',
        ${`moderator-${marker}`},
        'Moderation integration admin',
        'active'
      )
      returning id
    `;
    adminId = requireId(admins[0]?.id, "Admin");
    await postgres.sql`
      insert into platform.admin_assignments (
        admin_id,
        role_id,
        grant_source,
        granted_at
      )
      select
        ${adminId},
        role.id,
        'bootstrap',
        clock_timestamp()
      from platform.admin_roles as role
      where role.key = 'content_moderator'
    `;

    await postgres.sql.unsafe(`create role ${quoteRole(runtimeRole)} nologin noinherit`);
    await postgres.sql.unsafe(
      `grant usage on schema platform, system, public to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant select on table
        platform.action_logs,
        platform.admin_assignments,
        platform.admin_role_permissions,
        platform.admin_roles,
        platform.admins,
        platform.actors,
        platform.agents,
        platform.content_items,
        platform.content_revisions,
        platform.moderation_actions,
        platform.moderation_case_items,
        platform.moderation_cases,
        platform.owners,
        platform.report_submission_idempotency,
        platform.reports,
        system.outbox_aggregate_heads,
        system.outbox_events
      to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert on table platform.action_logs to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant execute on function
        platform.audit_json_is_secret_free(jsonb),
        platform.audit_json_is_secret_free_v2(jsonb)
      to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert (id, reporter_owner_id, reporter_actor_id, target_type,
        target_content_id, reason_code, description,
        authentication_assurance, idempotency_key, request_digest)
      on table platform.reports to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant update (version, status)
      on table platform.reports to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert (id, target_type, target_content_id)
      on table platform.moderation_cases to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant update (version, status, assigned_admin_id, resolution_code)
      on table platform.moderation_cases to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert (case_id, report_id)
      on table platform.moderation_case_items to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert (reporter_owner_id, reporter_actor_id, idempotency_key, request_digest, report_id)
      on table platform.report_submission_idempotency to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert (id, case_id, admin_id, permission_used, action,
        reason_code, internal_note, before_distribution_state,
        after_distribution_state, target_version_before, target_version_after,
        case_version_before, case_version_after, case_updated_at_after,
        case_closed_at_after, response_content_version,
        response_content_lifecycle_state, response_content_distribution_state,
        reverts_action_id, idempotency_key, request_digest, action_log_id,
        outbox_event_id)
      on table platform.moderation_actions to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant update (version, distribution_state)
      on table platform.content_items to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant insert on table system.outbox_aggregate_heads, system.outbox_events
      to ${quoteRole(runtimeRole)}`,
    );
    await postgres.sql.unsafe(
      `grant update on table system.outbox_aggregate_heads
      to ${quoteRole(runtimeRole)}`,
    );
  });

  afterAll(async () => {
    try {
      const roleExists = await postgres.sql<{ exists: boolean }[]>`
        select to_regrole(${runtimeRole}) is not null as exists
      `;
      if (roleExists[0]?.exists === true) {
        await postgres.sql.unsafe(`drop owned by ${quoteRole(runtimeRole)}`);
        await postgres.sql.unsafe(`drop role ${quoteRole(runtimeRole)}`);
      }
    } finally {
      await closeDependencies(dependencies);
    }
  });

  it("records the exact 000015 migration and installs the RBAC surface", async () => {
    const migration = await readFile(
      `${process.cwd()}/db/migrations/000015_web_reporting_content_moderation_v1.up.sql`,
    );
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM,
    );
    const ledger = await postgres.sql<
      { checksum: string; name: string; version: string }[]
    >`
      select version, name, checksum
      from system.schema_migrations
      where version = '000015'
    `;
    expect(ledger).toEqual([
      {
        checksum: WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM,
        name: "web_reporting_content_moderation_v1",
        version: "000015",
      },
    ]);

    const roleShape = await postgres.sql<
      { admins: number; permissions: number; roles: number }[]
    >`
      select
        (select count(*)::integer from platform.admins) as admins,
        (select count(distinct permission)::integer
         from platform.admin_role_permissions) as permissions,
        (select count(*)::integer from platform.admin_roles) as roles
    `;
    expect(roleShape[0]).toMatchObject({ permissions: 8, roles: 5 });
  });

  it("keeps the v1 report target boundary Content-only at schema and Runtime", async () => {
    const targetAgents = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.agents
      where actor_id = ${reporterActorId}
    `;
    const targetAgentId = requireId(targetAgents[0]?.id, "Target Agent");

    await expect(
      postgres.sql`
        insert into platform.reports (
          id,
          reporter_owner_id,
          reporter_actor_id,
          target_type,
          target_agent_id,
          reason_code,
          authentication_assurance,
          idempotency_key,
          request_digest
        )
        values (
          ${randomUUID()},
          ${reporterOwnerId},
          ${reporterActorId},
          'agent',
          ${targetAgentId},
          'spam',
          'owner_session',
          ${`agent-target-${randomUUID()}`},
          ${randomBytes(32)}
        )
      `,
    ).rejects.toThrow(/reports_target_shape/u);

    await expect(
      postgres.sql`
        insert into platform.moderation_cases (
          id,
          target_type,
          target_agent_id
        )
        values (${randomUUID()}, 'agent', ${targetAgentId})
      `,
    ).rejects.toThrow(/moderation_cases_target_shape/u);

    const privileges = await postgres.sql<
      { case_agent_insert: boolean; report_agent_insert: boolean }[]
    >`
      select
        has_column_privilege(
          ${runtimeRole},
          'platform.reports',
          'target_agent_id',
          'INSERT'
        ) as report_agent_insert,
        has_column_privilege(
          ${runtimeRole},
          'platform.moderation_cases',
          'target_agent_id',
          'INSERT'
        ) as case_agent_insert
    `;
    expect(privileges).toEqual([
      { case_agent_insert: false, report_agent_insert: false },
    ]);
  });

  it("creates a redacted Report event and active target case atomically", async () => {
    const content = await createContent("report-created");
    const report = await createReport(content.contentId, {
      description: "private reporter evidence",
    });
    const stored = await postgres.sql<
      {
        description: string;
        event_occurred_at: Date;
        payload: Record<string, unknown>;
        report_created_at: Date;
      }[]
    >`
      select
        report.description,
        report.created_at as report_created_at,
        event.occurred_at as event_occurred_at,
        event.payload
      from platform.reports as report
      join platform.moderation_case_items as item on item.report_id = report.id
      join system.outbox_events as event
        on event.aggregate_type = 'report'
       and event.aggregate_id = report.id::text
      where report.id = ${report.reportId}
        and item.case_id = ${report.caseId}
    `;
    expect(stored).toEqual([
      {
        description: "private reporter evidence",
        event_occurred_at: expect.any(Date),
        payload: {
          case_id: report.caseId,
          content_id: content.contentId,
          reason_code: "spam",
          report_id: report.reportId,
        },
        report_created_at: expect.any(Date),
      },
    ]);
    expect(stored[0]?.event_occurred_at.valueOf()).toBe(
      stored[0]?.report_created_at.valueOf(),
    );
    expect(JSON.stringify(stored[0]?.payload)).not.toContain("private reporter evidence");
  });

  it("runs Report creation and an Admin decision through the isolated Runtime role", async () => {
    const content = await createContent("runtime-services");
    const created = await runtimeReportService.createReport(
      {
        authenticationAssurance: "email_verified_owner_session",
        ownerId: reporterOwnerId,
        requestId: `runtime-report-${marker}`,
      },
      {
        contentId: content.contentId,
        details: "private Runtime role report detail",
        idempotencyKey: `runtime-report-${marker}`,
        reasonCode: "malicious_link",
        reporterActorId,
      },
    );
    expect(created).toMatchObject({
      created: true,
      report: { status: "open", version: 1 },
    });
    const additional = await runtimeReportService.createReport(
      {
        authenticationAssurance: "email_verified_owner_session",
        ownerId: secondReporterOwnerId,
        requestId: `runtime-report-second-${marker}`,
      },
      {
        contentId: content.contentId,
        idempotencyKey: `runtime-report-second-${marker}`,
        reasonCode: "privacy_exposure",
        reporterActorId: secondReporterActorId,
      },
    );
    expect(additional).toMatchObject({
      created: true,
      report: { caseId: created.report.caseId },
    });

    const adminContext: AdminModerationContext = {
      adminId,
      authenticationAssurance: "workforce_oidc",
      mfa: {
        amrMfa: true,
        matchedAcr: "urn:alphanet:mfa",
        method: "acr_and_amr_mfa",
      },
      permission: "moderation:decide",
      permissions: ["moderation:decide", "moderation:read"],
      requestId: `runtime-decision-${marker}`,
      roles: ["content_moderator"],
    };
    const decision = {
      action: "hide_content" as const,
      expectedCaseVersion: 2,
      idempotencyKey: `runtime-decision-${marker}`,
      internalNote: "private Runtime role moderation note",
      reasonCode: "confirmed_report_violation" as const,
    };
    await expect(
      runtimeModerationService.decideCase(adminContext, created.report.caseId, {
        ...decision,
        expectedCaseVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: "CASE_VERSION_CONFLICT",
      currentVersion: 2,
      statusCode: 409,
    });
    const decided = await runtimeModerationService.decideCase(
      adminContext,
      created.report.caseId,
      decision,
    );
    expect(decided).toMatchObject({
      action: {
        action: "hide_content",
        distributionAfter: "hidden",
      },
      case: { status: "resolved_action", version: 3 },
      content: { distributionState: "hidden", resourceVersion: 2 },
    });

    const stored = await postgres.sql<
      {
        action_occurred_at: Date;
        action_log_occurred_at: Date;
        case_closed_at: Date;
        case_updated_at: Date;
        event_occurred_at: Date;
        report_resolved_at: Date;
        submission_count: number;
      }[]
    >`
      select
        max(moderation_action.occurred_at) as action_occurred_at,
        max(action_log.occurred_at) as action_log_occurred_at,
        max(moderation_case.closed_at) as case_closed_at,
        max(moderation_case.updated_at) as case_updated_at,
        max(event.occurred_at) as event_occurred_at,
        max(report.resolved_at) as report_resolved_at,
        count(distinct submission.report_id)::integer as submission_count
      from platform.reports as report
      join platform.report_submission_idempotency as submission
        on submission.report_id = report.id
      join platform.moderation_case_items as item on item.report_id = report.id
      join platform.moderation_cases as moderation_case on moderation_case.id = item.case_id
      join platform.moderation_actions as moderation_action
        on moderation_action.case_id = moderation_case.id
      join platform.action_logs as action_log
        on action_log.id = moderation_action.action_log_id
      join system.outbox_events as event
        on event.id = moderation_action.outbox_event_id
      where moderation_case.id = ${created.report.caseId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ submission_count: 2 });
    expect(stored[0]?.action_occurred_at).toBeInstanceOf(Date);
    expect(stored[0]?.case_closed_at).toBeInstanceOf(Date);
    expect(stored[0]?.report_resolved_at).toBeInstanceOf(Date);
    expect(stored[0]?.action_occurred_at.valueOf()).toBe(
      stored[0]?.case_updated_at.valueOf(),
    );
    expect(stored[0]?.action_occurred_at.valueOf()).toBe(
      stored[0]?.case_closed_at.valueOf(),
    );
    expect(stored[0]?.action_occurred_at.valueOf()).toBe(
      stored[0]?.action_log_occurred_at.valueOf(),
    );
    expect(stored[0]?.action_occurred_at.valueOf()).toBe(
      stored[0]?.event_occurred_at.valueOf(),
    );
  });

  it("rejects self-reporting and a tampered Report event without partial rows", async () => {
    const content = await createContent("invalid-reports");
    await expect(
      createReport(content.contentId, {
        actorId: authorActorId,
        ownerId: requireId(
          (
            await postgres.sql<{ owner_id: string }[]>`
              select owner_id from platform.actors where id = ${authorActorId}
            `
          )[0]?.owner_id,
          "author Owner",
        ),
      }),
    ).rejects.toThrow(/matching case attachment and redacted Outbox event/u);

    const tamperedReportId = randomUUID();
    await expect(
      createReport(content.contentId, {
        payloadOverride: {
          case_id: randomUUID(),
          content_id: content.contentId,
          description: "leak",
          reason_code: "spam",
          report_id: tamperedReportId,
        },
      }),
    ).rejects.toThrow(/matching case attachment and redacted Outbox event/u);

    const counts = await postgres.sql<{ cases: number; reports: number }[]>`
      select
        count(distinct report.id)::integer as reports,
        count(distinct moderation_case.id)::integer as cases
      from platform.reports as report
      full join platform.moderation_cases as moderation_case
        on moderation_case.target_content_id = report.target_content_id
      where report.target_content_id = ${content.contentId}
         or moderation_case.target_content_id = ${content.contentId}
    `;
    expect(counts[0]).toEqual({ cases: 0, reports: 0 });
  });

  it("rejects a Runtime Report for a deleted Content target", async () => {
    const content = await createContent("deleted-report-target");
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          lifecycle_state = 'deleted',
          deleted_at = clock_timestamp()
      where id = ${content.contentId}
    `;

    await expect(createReport(content.contentId)).rejects.toThrow(
      /matching case attachment and redacted Outbox event/u,
    );
    await expectNoReportingRows(content.contentId);
  });

  it("rejects a Runtime Report for a hidden Content target", async () => {
    const content = await createContent("hidden-report-target");
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${content.contentId}
    `;

    await expect(createReport(content.contentId)).rejects.toThrow(
      /matching case attachment and redacted Outbox event/u,
    );
    await expectNoReportingRows(content.contentId);
  });

  it("rejects a Runtime Report for a reply beneath a hidden root", async () => {
    const root = await createContent("hidden-report-root");
    const reply = await createReply(root, "hidden-report-root-child");
    await postgres.sql`
      update platform.content_items
      set version = version + 1,
          distribution_state = 'hidden'
      where id = ${root.contentId}
    `;

    await expect(createReport(reply.contentId)).rejects.toThrow(
      /matching case attachment and redacted Outbox event/u,
    );
    await expectNoReportingRows(reply.contentId);
  });

  it("rejects a direct Runtime distribution update and rolls it back", async () => {
    const content = await createContent("direct-bypass");
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          update platform.content_items
          set version = 2, distribution_state = 'hidden'
          where id = ${content.contentId} and version = 1
        `;
      }),
    ).rejects.toThrow(/moderation, RBAC, audit, and Outbox provenance/u);

    const unchanged = await postgres.sql<
      { distribution_state: string; version: number }[]
    >`
      select distribution_state, version::integer as version
      from platform.content_items
      where id = ${content.contentId}
    `;
    expect(unchanged).toEqual([{ distribution_state: "normal", version: 1 }]);
  });

  it("rejects unaudited non-terminal Report and Case state changes", async () => {
    const content = await createContent("direct-review-bypass");
    const report = await createReport(content.contentId);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          update platform.reports
          set version = version + 1,
              status = 'reviewing'
          where id = ${report.reportId}
            and status = 'open'
        `;
      }),
    ).rejects.toThrow(/audited terminal decision transaction/u);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          update platform.moderation_cases
          set version = version + 1,
              status = 'reviewing',
              assigned_admin_id = ${adminId}
          where id = ${report.caseId}
            and status = 'open'
        `;
      }),
    ).rejects.toThrow(/audited terminal decision transaction/u);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          update platform.moderation_cases
          set priority = 'urgent'
          where id = ${report.caseId}
        `;
      }),
    ).rejects.toThrow(/permission denied/u);

    const unchanged = await postgres.sql<
      {
        assigned_admin_id: string | null;
        case_status: string;
        case_version: number;
        priority: string;
        report_status: string;
        report_version: number;
      }[]
    >`
      select
        report.version::integer as report_version,
        report.status as report_status,
        moderation_case.version::integer as case_version,
        moderation_case.status as case_status,
        moderation_case.priority,
        moderation_case.assigned_admin_id::text as assigned_admin_id
      from platform.reports as report
      join platform.moderation_case_items as item on item.report_id = report.id
      join platform.moderation_cases as moderation_case on moderation_case.id = item.case_id
      where report.id = ${report.reportId}
    `;
    expect(unchanged).toEqual([
      {
        assigned_admin_id: null,
        case_status: "open",
        case_version: 1,
        priority: "normal",
        report_status: "open",
        report_version: 1,
      },
    ]);
  });

  it("rejects a Runtime Report bundle that does not advance its existing Case", async () => {
    const content = await createContent("report-without-case-version");
    const first = await createReport(content.contentId);
    const secondReportId = randomUUID();
    const idempotencyKey = `report-${secondReportId}`;
    const digest = createHash("sha256").update(secondReportId).digest();
    await expect(
      asRuntime(async (transaction) => {
        const reportRows = await transaction<{ created_at: Date }[]>`
          insert into platform.reports (
            id,
            reporter_owner_id,
            reporter_actor_id,
            target_type,
            target_content_id,
            reason_code,
            description,
            authentication_assurance,
            idempotency_key,
            request_digest
          )
          values (
            ${secondReportId},
            ${secondReporterOwnerId},
            ${secondReporterActorId},
            'content',
            ${content.contentId},
            'spam',
            'attempted attachment without Case version advancement',
            'owner_session',
            ${idempotencyKey},
            ${digest}
          )
          returning created_at
        `;
        const eventTime = reportRows[0]?.created_at;
        if (!eventTime) throw new Error("Second Report fixture has no timestamp.");
        await transaction`
          insert into platform.moderation_case_items (case_id, report_id)
          values (${first.caseId}, ${secondReportId})
        `;
        await transaction`
          insert into platform.report_submission_idempotency (
            reporter_owner_id,
            reporter_actor_id,
            idempotency_key,
            request_digest,
            report_id
          )
          values (
            ${secondReporterOwnerId},
            ${secondReporterActorId},
            ${idempotencyKey},
            ${digest},
            ${secondReportId}
          )
        `;
        await transaction`
          insert into system.outbox_events (
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
            'report',
            ${secondReportId},
            1,
            'report.created',
            1,
            ${transaction.json({
              case_id: first.caseId,
              content_id: content.contentId,
              reason_code: "spam",
              report_id: secondReportId,
            })},
            ${eventTime},
            ${eventTime},
            12,
            ${eventTime}
          )
        `;
      }),
    ).rejects.toThrow(/matching case attachment and redacted Outbox event/u);

    const unchanged = await postgres.sql<{ item_count: number; version: number }[]>`
      select
        count(item.report_id)::integer as item_count,
        moderation_case.version::integer as version
      from platform.moderation_cases as moderation_case
      join platform.moderation_case_items as item
        on item.case_id = moderation_case.id
      where moderation_case.id = ${first.caseId}
      group by moderation_case.version
    `;
    expect(unchanged).toEqual([{ item_count: 1, version: 1 }]);
  });

  it("commits a complete distribution-only moderation decision", async () => {
    const content = await createContent("valid-decision");
    const report = await createReport(content.contentId);
    const action = await moderateContent(content, report, {
      internalNote: "private moderation analysis",
    });

    const result = await postgres.sql<
      {
        case_time_aligned: boolean;
        case_status: string;
        distribution_state: string;
        event_payload: Record<string, unknown>;
        internal_note: string;
        report_time_aligned: boolean;
        report_status: string;
        version: number;
      }[]
    >`
      select
        content.distribution_state,
        content.version::integer as version,
        report.status as report_status,
        report.updated_at = report.resolved_at as report_time_aligned,
        moderation_case.status as case_status,
        moderation_case.updated_at = moderation_case.closed_at as case_time_aligned,
        moderation_action.internal_note,
        event.payload as event_payload
      from platform.content_items as content
      join platform.reports as report on report.id = ${report.reportId}
      join platform.moderation_cases as moderation_case
        on moderation_case.id = ${report.caseId}
      join platform.moderation_actions as moderation_action
        on moderation_action.id = ${action.actionId}
      join system.outbox_events as event
        on event.id = moderation_action.outbox_event_id
      where content.id = ${content.contentId}
    `;
    expect(result[0]).toMatchObject({
      case_status: "resolved_action",
      case_time_aligned: true,
      distribution_state: "limited",
      internal_note: "private moderation analysis",
      report_status: "resolved_action",
      report_time_aligned: true,
      version: 2,
    });
    const serialized = JSON.stringify(result[0]?.event_payload);
    expect(serialized).not.toContain("private moderation analysis");
    expect(serialized).not.toContain("private report detail");
  });

  it("restores Content through the same Case without mutating terminal Reports", async () => {
    const content = await createContent("restore-decision");
    const limitReport = await createReport(content.contentId);
    const limitAction = await moderateContent(content, limitReport);
    const reportBeforeRestore = await postgres.sql<
      { resolved_at: Date; status: string; updated_at: Date; version: number }[]
    >`
      select version::integer as version, status, updated_at, resolved_at
      from platform.reports
      where id = ${limitReport.reportId}
    `;
    const restoreAction = await restoreContent(
      content,
      limitReport,
      limitAction.actionId,
    );

    const result = await postgres.sql<
      {
        action: string;
        case_id: string;
        distribution_state: string;
        reverts_action_id: string;
        version: number;
      }[]
    >`
      select
        content.distribution_state,
        content.version::integer as version,
        moderation_action.action,
        moderation_action.case_id,
        moderation_action.reverts_action_id
      from platform.content_items as content
      join platform.moderation_actions as moderation_action
        on moderation_action.id = ${restoreAction.actionId}
      where content.id = ${content.contentId}
    `;
    expect(result).toEqual([
      {
        action: "restore_content",
        case_id: limitReport.caseId,
        distribution_state: "normal",
        reverts_action_id: limitAction.actionId,
        version: 3,
      },
    ]);
    const reportAfterRestore = await postgres.sql<
      { resolved_at: Date; status: string; updated_at: Date; version: number }[]
    >`
      select version::integer as version, status, updated_at, resolved_at
      from platform.reports
      where id = ${limitReport.reportId}
    `;
    expect(reportAfterRestore).toEqual(reportBeforeRestore);
  });

  it.each([
    ["kind", "reply"],
    ["root_content_id", randomUUID()],
    ["current_revision_id", randomUUID()],
    ["reason_code", "precautionary_distribution_limit"],
  ] as const)(
    "rejects tampered Content moderation event provenance: %s",
    async (field, value) => {
      const content = await createContent(`tamper-${field}`);
      const report = await createReport(content.contentId);
      await expect(
        moderateContent(content, report, {
          eventPayloadPatch: { [field]: value },
        }),
      ).rejects.toThrow(/provenance/u);

      const unchanged = await postgres.sql<
        {
          case_status: string;
          distribution_state: string;
          report_status: string;
          version: number;
        }[]
      >`
        select
          content.distribution_state,
          content.version::integer as version,
          report.status as report_status,
          moderation_case.status as case_status
        from platform.content_items as content
        join platform.reports as report on report.id = ${report.reportId}
        join platform.moderation_cases as moderation_case
          on moderation_case.id = ${report.caseId}
        where content.id = ${content.contentId}
      `;
      expect(unchanged).toEqual([
        {
          case_status: "open",
          distribution_state: "normal",
          report_status: "open",
          version: 1,
        },
      ]);
    },
  );

  it("rejects a governance audit snapshot that claims unassigned RBAC", async () => {
    const content = await createContent("tamper-rbac-snapshot");
    const report = await createReport(content.contentId);
    await expect(
      moderateContent(content, report, {
        authorizationSnapshot: {
          permission: "moderation:decide",
          permissions: ["audit:read", "moderation:decide", "moderation:read"],
          roles: ["content_moderator", "platform_admin"],
        },
      }),
    ).rejects.toThrow(/provenance/u);

    const rows = await postgres.sql<
      { actions: number; case_status: string; distribution_state: string }[]
    >`
      select
        content.distribution_state,
        moderation_case.status as case_status,
        count(action.id)::integer as actions
      from platform.moderation_cases as moderation_case
      join platform.content_items as content
        on content.id = moderation_case.target_content_id
      left join platform.moderation_actions as action
        on action.case_id = moderation_case.id
      where moderation_case.id = ${report.caseId}
      group by moderation_case.id, content.id
    `;
    expect(rows).toEqual([
      { actions: 0, case_status: "open", distribution_state: "normal" },
    ]);
  });

  it("rejects orphan protected governance Outbox and ActionLog records", async () => {
    const eventTime = new Date();
    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into system.outbox_events (
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
            'report',
            ${randomUUID()},
            1,
            'report.created',
            1,
            ${transaction.json({})},
            ${eventTime},
            ${eventTime},
            12,
            ${eventTime}
          )
        `;
      }),
    ).rejects.toThrow(/matching domain provenance/u);

    await expect(
      asRuntime(async (transaction) => {
        await transaction`
          insert into platform.action_logs (
            event_class,
            admin_id,
            channel,
            approval_method,
            authentication_assurance,
            authorization_snapshot,
            action,
            target_type,
            target_id,
            decision,
            outcome,
            request_id,
            reason_code
          )
          values (
            'governance',
            ${adminId},
            'admin_web',
            'admin_override',
            'workforce_oidc',
            ${transaction.json({
              permission: "moderation:decide",
              permissions: ["moderation:decide", "moderation:read"],
              roles: ["content_moderator"],
            })},
            'moderation.hide_content',
            'content',
            ${randomUUID()},
            'allow',
            'succeeded',
            ${`orphan-governance-${marker}`},
            'confirmed_report_violation'
          )
        `;
      }),
    ).rejects.toThrow(/matching moderation provenance/u);
  });

  it("keeps Runtime RBAC and deletion authority closed", async () => {
    const privileges = await postgres.sql<
      {
        assignment_delete: boolean;
        assignment_insert: boolean;
        case_closed_at_update: boolean;
        case_priority_update: boolean;
        report_idempotency_delete: boolean;
        report_idempotency_update: boolean;
        report_resolved_at_update: boolean;
        role_update: boolean;
        reports_delete: boolean;
      }[]
    >`
      select
        has_table_privilege(${runtimeRole}, 'platform.admin_assignments', 'INSERT')
          as assignment_insert,
        has_table_privilege(${runtimeRole}, 'platform.admin_assignments', 'DELETE')
          as assignment_delete,
        has_table_privilege(${runtimeRole}, 'platform.admin_roles', 'UPDATE')
          as role_update,
        has_table_privilege(${runtimeRole}, 'platform.reports', 'DELETE')
          as reports_delete,
        has_column_privilege(
          ${runtimeRole},
          'platform.reports',
          'resolved_at',
          'UPDATE'
        ) as report_resolved_at_update,
        has_column_privilege(
          ${runtimeRole},
          'platform.moderation_cases',
          'priority',
          'UPDATE'
        ) as case_priority_update,
        has_column_privilege(
          ${runtimeRole},
          'platform.moderation_cases',
          'closed_at',
          'UPDATE'
        ) as case_closed_at_update,
        has_table_privilege(
          ${runtimeRole},
          'platform.report_submission_idempotency',
          'UPDATE'
        ) as report_idempotency_update,
        has_table_privilege(
          ${runtimeRole},
          'platform.report_submission_idempotency',
          'DELETE'
        ) as report_idempotency_delete
    `;
    expect(privileges).toEqual([
      {
        assignment_delete: false,
        assignment_insert: false,
        case_closed_at_update: false,
        case_priority_update: false,
        report_idempotency_delete: false,
        report_idempotency_update: false,
        report_resolved_at_update: false,
        reports_delete: false,
        role_update: false,
      },
    ]);
  });
});
