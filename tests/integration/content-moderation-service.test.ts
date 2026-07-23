import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/agent-connection.js";
import {
  type AdminModerationContext,
  type ContentModerationError,
  PostgresContentModerationService,
} from "../../packages/domain/src/content-moderation.js";
import { PostgresContentReportService } from "../../packages/domain/src/content-report.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeContentModeration = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: "content-moderation-integration-pepper-material" },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

function requireId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

interface CaseFixture {
  caseId: string;
  contentId: string;
  reportId: string;
}

describeContentModeration("PostgresContentModerationService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(postgres.sql, agentOptions);
  const reportService = new PostgresContentReportService(postgres.sql);
  const moderationService = new PostgresContentModerationService(postgres.sql, {
    cursorSigningKey: Buffer.alloc(32, 0xa5),
  });
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  const contentModeratorRoleId = "4b756e75-bf2d-4aa4-8ac4-5bd474290101";
  let adminId = "";
  let anotherAdminId = "";
  let revokedAdminId = "";
  let authorActorId = "";
  let authorOwnerId = "";
  let communityId = "";
  let futureAdminId = "";
  let reporterActorId = "";
  let reporterOwnerId = "";
  let secondReporterActorId = "";
  let secondReporterOwnerId = "";
  let thirdReporterActorId = "";
  let thirdReporterOwnerId = "";

  async function createVerifiedOwner(label: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${`Content Moderation ${label}`},
        ${`content-moderation-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const owners = await postgres.sql<{ id: string }[]>`
      select owner.id::text as id
      from platform.owners as owner
      where owner.auth_user_id = ${requireId(users[0]?.id, `${label} Auth User`)}
    `;
    return requireId(owners[0]?.id, `${label} Owner`);
  }

  async function createAdmin(label: string, futureGrant = false): Promise<string> {
    const rows = await postgres.sql<{ id: string }[]>`
      insert into platform.admins (
        oidc_issuer,
        oidc_subject,
        display_name,
        status
      )
      values (
        ${`https://workforce-${marker}.example.test`},
        ${`moderator-${label}-${marker}`},
        ${`Moderation ${label}`},
        'active'
      )
      returning id::text as id
    `;
    const id = requireId(rows[0]?.id, `${label} Admin`);
    await postgres.sql`
      insert into platform.admin_assignments (
        admin_id,
        role_id,
        grant_source,
        granted_at
      )
      values (
        ${id},
        ${contentModeratorRoleId},
        'bootstrap',
        case
          when ${futureGrant} then clock_timestamp() + interval '1 day'
          else clock_timestamp()
        end
      )
    `;
    return id;
  }

  async function createContent(label: string): Promise<string> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Moderation integration target ${label} ${contentId}`;
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
          ${`Moderation integration ${label}`},
          ${body},
          ${body},
          ${authorActorId},
          1,
          ${Buffer.alloc(32, 0x6d)},
          512
        )
      `;
      await transaction`
        update platform.content_items
        set current_revision_id = ${revisionId}
        where id = ${contentId}
      `;
      const projections = await transaction<
        Array<{
          actor_id: string;
          community_ids: string[];
          event_time: Date;
          kind: "post" | "reply";
          parent_content_id: string | null;
          revision_id: string;
          root_content_id: string;
          symbol_ids: string[];
          topic_ids: string[];
        }>
      >`
        select
          content.author_actor_id::text as actor_id,
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
          clock_timestamp() as event_time,
          content.kind,
          content.parent_id::text as parent_content_id,
          content.current_revision_id::text as revision_id,
          content.root_id::text as root_content_id,
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
        where content.id = ${contentId}
        limit 1
      `;
      const projection = projections[0];
      if (!projection) throw new Error("Content Outbox projection was not found");
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
          'content',
          ${contentId},
          1,
          'content.published',
          1,
          ${transaction.json({
            actor_id: projection.actor_id,
            community_ids: projection.community_ids,
            content_id: contentId,
            kind: projection.kind,
            parent_content_id: projection.parent_content_id,
            revision_id: projection.revision_id,
            root_content_id: projection.root_content_id,
            symbol_ids: projection.symbol_ids,
            topic_ids: projection.topic_ids,
          })},
          ${projection.event_time},
          ${projection.event_time},
          12,
          ${projection.event_time}
        )
      `;
    });
    return contentId;
  }

  async function createCase(
    label: string,
    options: {
      details?: string;
      reasonCode?: "harassment" | "malicious_link" | "privacy_exposure" | "spam";
      reporterActorId?: string;
      reporterOwnerId?: string;
    } = {},
  ): Promise<CaseFixture> {
    const contentId = await createContent(label);
    const result = await reportService.createReport(
      {
        authenticationAssurance: "email_verified_owner_session",
        ownerId: options.reporterOwnerId ?? reporterOwnerId,
        requestId: `req-report-${label}-${marker}`,
      },
      {
        contentId,
        details: options.details,
        idempotencyKey: `report-${label}-${marker}`,
        reasonCode: options.reasonCode ?? "spam",
        reporterActorId: options.reporterActorId ?? reporterActorId,
      },
    );
    return {
      caseId: result.report.caseId,
      contentId,
      reportId: result.report.id,
    };
  }

  function context(
    admin: string,
    permission: "moderation:decide" | "moderation:read",
    requestId: string,
  ): AdminModerationContext {
    return {
      adminId: admin,
      authenticationAssurance: "workforce_oidc",
      mfa: {
        amrMfa: true,
        matchedAcr: "urn:alphanet:mfa",
        method: "acr_and_amr_mfa",
      },
      permission,
      permissions: ["moderation:decide", "moderation:read"],
      requestId,
      roles: ["content_moderator"],
    };
  }

  beforeAll(async () => {
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
        ${`moderation-service-${marker}`},
        'Content moderation integration',
        'Isolated Community for Content moderation Service tests.',
        'general'
      )
    `;

    authorOwnerId = await createVerifiedOwner("author");
    const author = await agentService.createAgent(
      authorOwnerId,
      {
        displayName: "Moderation Target Author Agent",
        handle: `mod-author-${marker}`,
      },
      randomUUID(),
    );
    authorActorId = author.agent.actorId;

    reporterOwnerId = await createVerifiedOwner("reporter");
    const reporter = await agentService.createAgent(
      reporterOwnerId,
      {
        displayName: "Moderation Reporter Agent",
        handle: `mod-reporter-${marker}`,
      },
      randomUUID(),
    );
    reporterActorId = reporter.agent.actorId;
    secondReporterOwnerId = await createVerifiedOwner("reporter-two");
    const secondReporter = await agentService.createAgent(
      secondReporterOwnerId,
      {
        displayName: "Second Moderation Reporter Agent",
        handle: `mod-reporter-two-${marker}`,
      },
      randomUUID(),
    );
    secondReporterActorId = secondReporter.agent.actorId;
    thirdReporterOwnerId = await createVerifiedOwner("reporter-three");
    const thirdReporter = await agentService.createAgent(
      thirdReporterOwnerId,
      {
        displayName: "Third Moderation Reporter Agent",
        handle: `mod-reporter-three-${marker}`,
      },
      randomUUID(),
    );
    thirdReporterActorId = thirdReporter.agent.actorId;

    adminId = await createAdmin("primary");
    anotherAdminId = await createAdmin("assigned");
    revokedAdminId = await createAdmin("revoked");
    futureAdminId = await createAdmin("future", true);
    await postgres.sql`
      update platform.admin_assignments
      set revoked_at = clock_timestamp()
      where admin_id = ${revokedAdminId}
        and role_id = ${contentModeratorRoleId}
        and revoked_at is null
    `;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("passes the exact moderation schema readiness gate", async () => {
    await expect(moderationService.checkReady()).resolves.toBeUndefined();
  });

  it("revalidates Admin RBAC from PostgreSQL instead of trusting request claims", async () => {
    const requestId = `req-rbac-revoked-${marker}`;
    const futureRequestId = `req-rbac-future-${marker}`;
    await expect(
      moderationService.listCases(
        context(revokedAdminId, "moderation:read", requestId),
        {},
      ),
    ).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
      statusCode: 403,
    } satisfies Partial<ContentModerationError>);
    await expect(
      moderationService.listCases(
        context(futureAdminId, "moderation:read", futureRequestId),
        {},
      ),
    ).rejects.toMatchObject({
      code: "ADMIN_PERMISSION_REQUIRED",
      statusCode: 403,
    } satisfies Partial<ContentModerationError>);

    const writes = await postgres.sql<{ count: number }[]>`
      select count(*)::integer as count
      from platform.action_logs as log
      where log.request_id in (${requestId}, ${futureRequestId})
    `;
    expect(writes).toEqual([{ count: 0 }]);
  });

  it("lists safe Case summaries and audits sensitive detail reads without copying secrets", async () => {
    const reportSecret = `private reporter evidence ${marker}`;
    const fixture = await createCase("sensitive-read", {
      details: reportSecret,
      reasonCode: "privacy_exposure",
    });
    const listRequestId = `req-case-list-${marker}`;
    const detailRequestId = `req-case-detail-${marker}`;

    const queue = await moderationService.listCases(
      context(adminId, "moderation:read", listRequestId),
      { contentId: fixture.contentId, reasons: ["privacy_exposure"] },
    );
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      caseId: fixture.caseId,
      contentId: fixture.contentId,
      reasonCounts: { privacy_exposure: 1 },
      reportCount: 1,
      status: "open",
    });
    expect(Object.hasOwn(queue.items[0] ?? {}, "details")).toBe(false);

    const detail = await moderationService.getCase(
      context(adminId, "moderation:read", detailRequestId),
      fixture.caseId,
      {},
    );
    expect(detail.reports.items).toHaveLength(1);
    expect(detail.reports.items[0]).toMatchObject({
      contentId: fixture.contentId,
      details: reportSecret,
      reportId: fixture.reportId,
      reporterActorId,
      reporterOwnerId,
    });

    const audits = await postgres.sql<
      {
        action: string;
        after_state: unknown;
        authorization_snapshot: unknown;
        before_state: unknown;
        event_class: string;
        outbox_event_id: string | null;
        request_id: string;
      }[]
    >`
      select
        log.event_class,
        log.action,
        log.request_id,
        log.authorization_snapshot,
        log.before_state,
        log.after_state,
        log.outbox_event_id::text as outbox_event_id
      from platform.action_logs as log
      where log.request_id in (${listRequestId}, ${detailRequestId})
      order by log.occurred_at, log.id
    `;
    expect(audits).toEqual([
      expect.objectContaining({
        action: "moderation.case_sensitive_read",
        authorization_snapshot: {
          permission: "moderation:read",
          permissions: ["moderation:decide", "moderation:read"],
          roles: ["content_moderator"],
        },
        event_class: "sensitive_read",
        outbox_event_id: null,
        request_id: detailRequestId,
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(reportSecret);
  });

  it("keeps a detail cursor usable when later evidence advances the live Case", async () => {
    const fixture = await createCase("live-detail-pagination");
    const report = async (ownerId: string, actorId: string, suffix: string) =>
      reportService.createReport(
        {
          authenticationAssurance: "email_verified_owner_session",
          ownerId,
          requestId: `req-live-detail-${suffix}-${marker}`,
        },
        {
          contentId: fixture.contentId,
          idempotencyKey: `live-detail-${suffix}-${marker}`,
          reasonCode: "spam",
          reporterActorId: actorId,
        },
      );

    await report(secondReporterOwnerId, secondReporterActorId, "second");
    const firstPage = await moderationService.getCase(
      context(adminId, "moderation:read", `req-live-detail-page-1-${marker}`),
      fixture.caseId,
      { reportLimit: 1 },
    );
    expect(firstPage.case.version).toBe(2);
    expect(firstPage.reports.nextCursor).not.toBeNull();

    await report(thirdReporterOwnerId, thirdReporterActorId, "third");
    const secondPage = await moderationService.getCase(
      context(adminId, "moderation:read", `req-live-detail-page-2-${marker}`),
      fixture.caseId,
      {
        reportCursor: firstPage.reports.nextCursor,
        reportLimit: 1,
      },
    );
    expect(secondPage.case.version).toBe(3);
    expect(secondPage.reports.snapshotId).toBe(firstPage.reports.snapshotId);
    expect(secondPage.reports.items).toHaveLength(1);
    expect(secondPage.reports.items[0]?.reportId).not.toBe(
      firstPage.reports.items[0]?.reportId,
    );
  });

  it("atomically hides Content and closes the Case and Reports with complete provenance", async () => {
    const reportSecret = `report secret must remain private ${marker}`;
    const internalNote = `workforce note must remain private ${marker}`;
    const fixture = await createCase("hide-decision", {
      details: reportSecret,
      reasonCode: "malicious_link",
    });
    const requestId = `req-hide-decision-${marker}`;
    const idempotencyKey = `hide-decision-${marker}`;
    const decision = {
      action: "hide_content" as const,
      expectedCaseVersion: 1,
      idempotencyKey,
      internalNote,
      reasonCode: "confirmed_report_violation" as const,
    };

    await expect(
      moderationService.decideCase(
        context(adminId, "moderation:decide", `req-stale-${marker}`),
        fixture.caseId,
        { ...decision, expectedCaseVersion: 2 },
      ),
    ).rejects.toMatchObject({
      code: "CASE_VERSION_CONFLICT",
      currentVersion: 1,
      statusCode: 409,
    } satisfies Partial<ContentModerationError>);

    const outcome = await moderationService.decideCase(
      context(adminId, "moderation:decide", requestId),
      fixture.caseId,
      decision,
    );
    expect(outcome).toMatchObject({
      action: {
        action: "hide_content",
        contentVersionAfter: 2,
        contentVersionBefore: 1,
        distributionAfter: "hidden",
        distributionBefore: "normal",
        internalNote,
        reasonCode: "confirmed_report_violation",
      },
      case: {
        caseId: fixture.caseId,
        status: "resolved_action",
        version: 2,
      },
      caseVersionBefore: 1,
      content: {
        contentId: fixture.contentId,
        distributionState: "hidden",
        resourceVersion: 2,
      },
      replayed: false,
    });

    const provenance = await postgres.sql<
      {
        action: string;
        action_log_id: string;
        action_xid: string;
        after_distribution_state: string;
        after_state: unknown;
        assigned_admin_id: string;
        authorization_snapshot: unknown;
        before_distribution_state: string;
        before_state: unknown;
        case_closed_at: Date;
        case_resolution_code: string;
        case_status: string;
        case_updated_at: Date;
        case_version: number;
        case_xid: string;
        content_distribution_state: string;
        content_version: number;
        content_xid: string;
        event_payload: unknown;
        event_type: string;
        event_xid: string;
        internal_note: string;
        log_action: string;
        log_reason_code: string;
        log_request_id: string;
        log_xid: string;
        moderation_action_id: string;
        outbox_event_id: string;
        report_resolved_at: Date;
        report_status: string;
        report_updated_at: Date;
        report_version: number;
        report_xid: string;
        target_version_after: number;
        target_version_before: number;
      }[]
    >`
      select
        action.id::text as moderation_action_id,
        action.action,
        action.internal_note,
        action.before_distribution_state,
        action.after_distribution_state,
        action.target_version_before::integer as target_version_before,
        action.target_version_after::integer as target_version_after,
        action.action_log_id::text as action_log_id,
        action.outbox_event_id::text as outbox_event_id,
        action.xmin::text as action_xid,
        content.version::integer as content_version,
        content.distribution_state as content_distribution_state,
        content.xmin::text as content_xid,
        moderation_case.version::integer as case_version,
        moderation_case.status as case_status,
        moderation_case.assigned_admin_id::text as assigned_admin_id,
        moderation_case.resolution_code as case_resolution_code,
        moderation_case.updated_at as case_updated_at,
        moderation_case.closed_at as case_closed_at,
        moderation_case.xmin::text as case_xid,
        report.version::integer as report_version,
        report.status as report_status,
        report.updated_at as report_updated_at,
        report.resolved_at as report_resolved_at,
        report.xmin::text as report_xid,
        log.action as log_action,
        log.request_id as log_request_id,
        log.reason_code as log_reason_code,
        log.authorization_snapshot,
        log.before_state,
        log.after_state,
        log.xmin::text as log_xid,
        event.event_type,
        event.payload as event_payload,
        event.xmin::text as event_xid
      from platform.moderation_actions as action
      join platform.moderation_cases as moderation_case
        on moderation_case.id = action.case_id
      join platform.moderation_case_items as item
        on item.case_id = moderation_case.id
      join platform.reports as report on report.id = item.report_id
      join platform.content_items as content
        on content.id = moderation_case.target_content_id
      join platform.action_logs as log on log.id = action.action_log_id
      join system.outbox_events as event on event.id = action.outbox_event_id
      where action.id = ${outcome.action.moderationActionId}
        and report.id = ${fixture.reportId}
    `;
    expect(provenance).toHaveLength(1);
    const record = provenance[0];
    expect(record).toMatchObject({
      action: "hide_content",
      action_log_id: expect.any(String),
      after_distribution_state: "hidden",
      assigned_admin_id: adminId,
      authorization_snapshot: {
        permission: "moderation:decide",
        permissions: ["moderation:decide", "moderation:read"],
        roles: ["content_moderator"],
      },
      before_distribution_state: "normal",
      before_state: { distribution_state: "normal", resource_version: 1 },
      case_resolution_code: "content_hidden",
      case_status: "resolved_action",
      case_version: 2,
      content_distribution_state: "hidden",
      content_version: 2,
      event_payload: {
        after_distribution_state: "hidden",
        before_distribution_state: "normal",
        case_id: fixture.caseId,
        content_id: fixture.contentId,
        current_revision_id: expect.any(String),
        kind: "post",
        moderation_action_id: outcome.action.moderationActionId,
        reason_code: "confirmed_report_violation",
        resource_version: 2,
        root_content_id: fixture.contentId,
      },
      event_type: "content.moderation_changed",
      internal_note: internalNote,
      log_action: "moderation.hide_content",
      log_reason_code: "confirmed_report_violation",
      log_request_id: requestId,
      moderation_action_id: outcome.action.moderationActionId,
      outbox_event_id: expect.any(String),
      report_status: "resolved_action",
      report_version: 2,
      target_version_after: 2,
      target_version_before: 1,
    });
    expect(record?.case_updated_at).toEqual(record?.case_closed_at);
    expect(record?.report_updated_at).toEqual(record?.report_resolved_at);
    expect(
      new Set([
        record?.action_xid,
        record?.case_xid,
        record?.content_xid,
        record?.event_xid,
        record?.log_xid,
        record?.report_xid,
      ]),
    ).toEqual(new Set([record?.action_xid]));
    expect(
      JSON.stringify({
        afterState: record?.after_state,
        authorization: record?.authorization_snapshot,
        beforeState: record?.before_state,
        event: record?.event_payload,
      }),
    ).not.toContain(reportSecret);
    expect(JSON.stringify(record?.event_payload)).not.toContain(internalNote);
    expect(JSON.stringify(record?.before_state)).not.toContain(internalNote);
    expect(JSON.stringify(record?.after_state)).not.toContain(internalNote);

    const replay = await moderationService.decideCase(
      context(adminId, "moderation:decide", `req-hide-replay-${marker}`),
      fixture.caseId,
      decision,
    );
    expect(replay).toMatchObject({
      action: { moderationActionId: outcome.action.moderationActionId },
      replayed: true,
    });
    await expect(
      moderationService.decideCase(
        context(adminId, "moderation:decide", `req-hide-conflict-${marker}`),
        fixture.caseId,
        { ...decision, internalNote: `${internalNote} changed` },
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      statusCode: 409,
    } satisfies Partial<ContentModerationError>);

    const immutableCounts = await postgres.sql<
      { actions: number; governance_logs: number; moderation_events: number }[]
    >`
      select
        (select count(*)::integer
         from platform.moderation_actions
         where case_id = ${fixture.caseId}) as actions,
        (select count(*)::integer
         from platform.action_logs
         where request_id = ${requestId}) as governance_logs,
        (select count(*)::integer
         from system.outbox_events
         where event_type = 'content.moderation_changed'
           and payload ->> 'case_id' = ${fixture.caseId}) as moderation_events
    `;
    expect(immutableCounts).toEqual([
      { actions: 1, governance_logs: 1, moderation_events: 1 },
    ]);

    const ownerHistory = await moderationService.listContentActions(
      authorOwnerId,
      fixture.contentId,
      {},
    );
    expect(ownerHistory).toMatchObject({
      contentId: fixture.contentId,
      contentVersion: 2,
      distributionState: "hidden",
      page: {
        items: [
          {
            action: "hide_content",
            moderationActionId: outcome.action.moderationActionId,
            reasonCode: "confirmed_report_violation",
          },
        ],
      },
    });
    const ownerItem = ownerHistory.page.items[0] as unknown as Record<string, unknown>;
    expect(Object.hasOwn(ownerItem, "decidedByAdminId")).toBe(false);
    expect(Object.hasOwn(ownerItem, "internalNote")).toBe(false);
    expect(JSON.stringify(ownerHistory)).not.toContain(adminId);
    expect(JSON.stringify(ownerHistory)).not.toContain(internalNote);
  });

  it("rejects a decision when the Case is assigned to another Admin", async () => {
    const fixture = await createCase("assignment-conflict", {
      reasonCode: "harassment",
    });
    await postgres.sql`
      update platform.moderation_cases
      set version = version + 1,
          status = 'reviewing',
          assigned_admin_id = ${anotherAdminId}
      where id = ${fixture.caseId}
    `;

    await expect(
      moderationService.decideCase(
        context(adminId, "moderation:decide", `req-assignment-conflict-${marker}`),
        fixture.caseId,
        {
          action: "dismiss",
          expectedCaseVersion: 2,
          idempotencyKey: `assignment-conflict-${marker}`,
          reasonCode: "insufficient_evidence",
        },
      ),
    ).rejects.toMatchObject({
      code: "CASE_ASSIGNMENT_CONFLICT",
      currentVersion: 2,
      statusCode: 409,
    } satisfies Partial<ContentModerationError>);

    const state = await postgres.sql<
      { actions: number; assigned_admin_id: string; status: string; version: number }[]
    >`
      select
        moderation_case.version::integer as version,
        moderation_case.status,
        moderation_case.assigned_admin_id::text as assigned_admin_id,
        count(action.id)::integer as actions
      from platform.moderation_cases as moderation_case
      left join platform.moderation_actions as action
        on action.case_id = moderation_case.id
      where moderation_case.id = ${fixture.caseId}
      group by moderation_case.id
    `;
    expect(state).toEqual([
      {
        actions: 0,
        assigned_admin_id: anotherAdminId,
        status: "reviewing",
        version: 2,
      },
    ]);
  });

  it("restores the same Case without mutating Reports and freezes both replay snapshots", async () => {
    const fixture = await createCase("immutable-enforcement-replay", {
      reasonCode: "spam",
    });
    const oldDecision = {
      action: "hide_content" as const,
      expectedCaseVersion: 1,
      idempotencyKey: `immutable-hide-${marker}`,
      reasonCode: "confirmed_report_violation" as const,
    };
    const hidden = await moderationService.decideCase(
      context(adminId, "moderation:decide", `req-immutable-hide-${marker}`),
      fixture.caseId,
      oldDecision,
    );
    expect(hidden.content).toMatchObject({
      distributionState: "hidden",
      lifecycleState: "published",
      resourceVersion: 2,
    });

    const reportBeforeRestore = await postgres.sql<
      { resolved_at: Date; status: string; updated_at: Date; version: number }[]
    >`
      select
        version::integer as version,
        status,
        updated_at,
        resolved_at
      from platform.reports
      where id = ${fixture.reportId}
    `;
    const restored = await moderationService.decideCase(
      context(anotherAdminId, "moderation:decide", `req-immutable-restore-${marker}`),
      fixture.caseId,
      {
        action: "restore_content",
        expectedCaseVersion: 2,
        idempotencyKey: `immutable-restore-${marker}`,
        reasonCode: "appeal_granted",
      },
    );
    expect(restored.content).toMatchObject({
      distributionState: "normal",
      lifecycleState: "published",
      resourceVersion: 3,
    });
    expect(restored).toMatchObject({
      case: {
        caseId: fixture.caseId,
        latestActionId: restored.action.moderationActionId,
        resolutionAction: "restore_content",
        status: "resolved_action",
        version: 3,
      },
      caseVersionBefore: 2,
      replayed: false,
    });
    expect(restored.action).toMatchObject({
      action: "restore_content",
      decidedByAdminId: anotherAdminId,
      revertedActionId: hidden.action.moderationActionId,
    });

    const reportAfterRestore = await postgres.sql<
      { resolved_at: Date; status: string; updated_at: Date; version: number }[]
    >`
      select
        version::integer as version,
        status,
        updated_at,
        resolved_at
      from platform.reports
      where id = ${fixture.reportId}
    `;
    expect(reportAfterRestore).toEqual(reportBeforeRestore);

    const replay = await moderationService.decideCase(
      context(adminId, "moderation:decide", `req-immutable-replay-${marker}`),
      fixture.caseId,
      oldDecision,
    );
    expect(replay).toMatchObject({
      action: {
        contentVersionAfter: 2,
        distributionAfter: "hidden",
        moderationActionId: hidden.action.moderationActionId,
      },
      case: {
        contentVersion: 2,
        distributionState: "hidden",
        latestActionId: hidden.action.moderationActionId,
        resolutionAction: "hide_content",
        version: 2,
      },
      content: {
        distributionState: "hidden",
        lifecycleState: "published",
        resourceVersion: 2,
      },
      replayed: true,
    });

    const restoreReplay = await moderationService.decideCase(
      context(
        anotherAdminId,
        "moderation:decide",
        `req-immutable-restore-replay-${marker}`,
      ),
      fixture.caseId,
      {
        action: "restore_content",
        expectedCaseVersion: 2,
        idempotencyKey: `immutable-restore-${marker}`,
        reasonCode: "appeal_granted",
      },
    );
    expect(restoreReplay).toEqual({ ...restored, replayed: true });
  });

  it("serializes a competing Report and moderation decision without losing evidence", async () => {
    const initialReporterOwnerId = await createVerifiedOwner("race-initial");
    const initialReporter = await agentService.createAgent(
      initialReporterOwnerId,
      {
        displayName: "Race Initial Reporter Agent",
        handle: `mod-race-initial-${marker}`,
      },
      randomUUID(),
    );
    const fixture = await createCase("report-decision-race", {
      reporterActorId: initialReporter.agent.actorId,
      reporterOwnerId: initialReporterOwnerId,
    });
    const outcomes = await Promise.allSettled([
      reportService.createReport(
        {
          authenticationAssurance: "email_verified_owner_session",
          ownerId: secondReporterOwnerId,
          requestId: `req-race-report-${marker}`,
        },
        {
          contentId: fixture.contentId,
          idempotencyKey: `race-report-${marker}`,
          reasonCode: "malicious_link",
          reporterActorId: secondReporterActorId,
        },
      ),
      moderationService.decideCase(
        context(adminId, "moderation:decide", `req-race-decision-${marker}`),
        fixture.caseId,
        {
          action: "hide_content",
          expectedCaseVersion: 1,
          idempotencyKey: `race-decision-${marker}`,
          reasonCode: "confirmed_report_violation",
        },
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const rows = await postgres.sql<
      {
        action_count: number;
        case_status: string;
        case_version: number;
        distribution_state: string;
        report_count: number;
      }[]
    >`
      select
        moderation_case.version::integer as case_version,
        moderation_case.status as case_status,
        content.distribution_state,
        count(distinct item.report_id)::integer as report_count,
        count(distinct action.id)::integer as action_count
      from platform.moderation_cases as moderation_case
      join platform.content_items as content
        on content.id = moderation_case.target_content_id
      join platform.moderation_case_items as item
        on item.case_id = moderation_case.id
      left join platform.moderation_actions as action
        on action.case_id = moderation_case.id
      where moderation_case.id = ${fixture.caseId}
      group by moderation_case.id, content.id
    `;
    expect(rows[0]).toEqual(
      rows[0]?.action_count === 1
        ? {
            action_count: 1,
            case_status: "resolved_action",
            case_version: 2,
            distribution_state: "hidden",
            report_count: 1,
          }
        : {
            action_count: 0,
            case_status: "open",
            case_version: 2,
            distribution_state: "normal",
            report_count: 2,
          },
    );
  });

  it("allows exactly one of two concurrent restore commands", async () => {
    const restoreReporterOwnerId = await createVerifiedOwner("restore-race");
    const restoreReporter = await agentService.createAgent(
      restoreReporterOwnerId,
      {
        displayName: "Restore Race Reporter Agent",
        handle: `mod-restore-race-${marker}`,
      },
      randomUUID(),
    );
    const fixture = await createCase("restore-race", {
      reporterActorId: restoreReporter.agent.actorId,
      reporterOwnerId: restoreReporterOwnerId,
    });
    await moderationService.decideCase(
      context(adminId, "moderation:decide", `req-restore-race-hide-${marker}`),
      fixture.caseId,
      {
        action: "hide_content",
        expectedCaseVersion: 1,
        idempotencyKey: `restore-race-hide-${marker}`,
        reasonCode: "confirmed_report_violation",
      },
    );

    const restore = (actingAdminId: string, suffix: string) =>
      moderationService.decideCase(
        context(
          actingAdminId,
          "moderation:decide",
          `req-restore-race-${suffix}-${marker}`,
        ),
        fixture.caseId,
        {
          action: "restore_content",
          expectedCaseVersion: 2,
          idempotencyKey: `restore-race-${suffix}-${marker}`,
          reasonCode: "moderation_error_corrected",
        },
      );
    const outcomes = await Promise.allSettled([
      restore(adminId, "one"),
      restore(anotherAdminId, "two"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "CASE_VERSION_CONFLICT", currentVersion: 3 },
      status: "rejected",
    });

    const rows = await postgres.sql<
      { actions: number; distribution_state: string; version: number }[]
    >`
      select
        moderation_case.version::integer as version,
        content.distribution_state,
        count(action.id)::integer as actions
      from platform.moderation_cases as moderation_case
      join platform.content_items as content
        on content.id = moderation_case.target_content_id
      join platform.moderation_actions as action
        on action.case_id = moderation_case.id
      where moderation_case.id = ${fixture.caseId}
      group by moderation_case.id, content.id
    `;
    expect(rows).toEqual([{ actions: 2, distribution_state: "normal", version: 3 }]);
  });
});
