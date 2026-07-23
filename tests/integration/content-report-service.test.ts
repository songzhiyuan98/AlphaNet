import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/agent-connection.js";
import {
  PostgresContentReportService,
  type ContentReportError,
} from "../../packages/domain/src/content-report.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeContentReport = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: "content-report-integration-pepper-material" },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

function requireId(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not created`);
  return value;
}

describeContentReport("PostgresContentReportService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(postgres.sql, agentOptions);
  const reportService = new PostgresContentReportService(postgres.sql);
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  let aliasReporterActorId = "";
  let aliasReporterOwnerId = "";
  let aliasReporterSiblingActorId = "";
  let authorActorId = "";
  let authorOwnerId = "";
  let authorSiblingActorId = "";
  let communityId = "";
  let reporterActorId = "";
  let reporterOwnerId = "";
  let reporterSiblingActorId = "";
  let secondReporterActorId = "";
  let secondReporterOwnerId = "";

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
        ${`Content Report ${label}`},
        ${`content-report-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const owner = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${requireId(users[0]?.id, `${label} Auth User`)}
    `;
    return requireId(owner[0]?.id, `${label} Owner`);
  }

  async function createContent(label: string): Promise<string> {
    const contentId = randomUUID();
    const revisionId = randomUUID();
    const body = `Content report integration evidence ${label} ${contentId}`;
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
          ${`Content report ${label}`},
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

  function request(ownerId: string, suffix: string) {
    return {
      authenticationAssurance: "email_verified_owner_session",
      ownerId,
      requestId: `req-content-report-${suffix}`,
    } as const;
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
        ${`content-report-${marker}`},
        'Content reporting integration',
        'Isolated Community for reporting integration tests.',
        'general'
      )
    `;

    authorOwnerId = await createVerifiedOwner("author");
    const author = await agentService.createAgent(
      authorOwnerId,
      {
        displayName: "Content Report Author Agent",
        handle: `report-author-${marker}`,
      },
      randomUUID(),
    );
    authorActorId = author.agent.actorId;
    const authorSibling = await agentService.createAgent(
      authorOwnerId,
      {
        displayName: "Content Report Author Sibling Agent",
        handle: `report-author-sibling-${marker}`,
      },
      randomUUID(),
    );
    authorSiblingActorId = authorSibling.agent.actorId;

    reporterOwnerId = await createVerifiedOwner("reporter");
    const reporter = await agentService.createAgent(
      reporterOwnerId,
      {
        displayName: "Content Report Reporter Agent",
        handle: `reporter-${marker}`,
      },
      randomUUID(),
    );
    reporterActorId = reporter.agent.actorId;
    const reporterSibling = await agentService.createAgent(
      reporterOwnerId,
      {
        displayName: "Content Report Reporter Sibling Agent",
        handle: `reporter-sibling-${marker}`,
      },
      randomUUID(),
    );
    reporterSiblingActorId = reporterSibling.agent.actorId;

    secondReporterOwnerId = await createVerifiedOwner("second-reporter");
    const secondReporter = await agentService.createAgent(
      secondReporterOwnerId,
      {
        displayName: "Second Owner Content Report Agent",
        handle: `reporter-two-${marker}`,
      },
      randomUUID(),
    );
    secondReporterActorId = secondReporter.agent.actorId;

    aliasReporterOwnerId = await createVerifiedOwner("alias-reporter");
    const aliasReporter = await agentService.createAgent(
      aliasReporterOwnerId,
      {
        displayName: "Alias Quota Report Agent",
        handle: `report-alias-${marker}`,
      },
      randomUUID(),
    );
    aliasReporterActorId = aliasReporter.agent.actorId;
    const aliasReporterSibling = await agentService.createAgent(
      aliasReporterOwnerId,
      {
        displayName: "Alias Quota Report Sibling Agent",
        handle: `report-alias-sibling-${marker}`,
      },
      randomUUID(),
    );
    aliasReporterSiblingActorId = aliasReporterSibling.agent.actorId;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("passes the complete reporting schema readiness gate", async () => {
    await expect(reportService.checkReady()).resolves.toBeUndefined();
  });

  it("creates one redacted Report event and an active Case", async () => {
    const contentId = await createContent("first");
    const outcome = await reportService.createReport(request(reporterOwnerId, "first"), {
      contentId,
      details: "  private reporter evidence  ",
      idempotencyKey: `first-${marker}`,
      reasonCode: "spam",
      reporterActorId,
    });

    expect(outcome).toMatchObject({
      created: true,
      deduplicated: false,
      replayed: false,
      report: {
        caseId: expect.any(String),
        contentId,
        details: "private reporter evidence",
        reasonCode: "spam",
        reporterActorId,
        status: "open",
        version: 1,
      },
    });
    const rows = await postgres.sql<
      { case_count: number; description: string; event_count: number; payload: unknown }[]
    >`
      select
        report.description,
        event.payload,
        count(distinct item.case_id)::integer as case_count,
        count(distinct event.id)::integer as event_count
      from platform.reports as report
      join platform.moderation_case_items as item on item.report_id = report.id
      join system.outbox_events as event
        on event.aggregate_type = 'report'
       and event.aggregate_id = report.id::text
      where report.id = ${outcome.report.id}
      group by report.description, event.payload
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      case_count: 1,
      description: "private reporter evidence",
      event_count: 1,
      payload: {
        case_id: outcome.report.caseId,
        content_id: contentId,
        reason_code: "spam",
        report_id: outcome.report.id,
      },
    });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("private reporter evidence");
  });

  it("replays one key and rejects the same key with another digest", async () => {
    const contentId = await createContent("idempotency");
    const input = {
      contentId,
      idempotencyKey: `idempotency-${marker}`,
      reasonCode: "harassment" as const,
      reporterActorId,
    };
    const first = await reportService.createReport(
      request(reporterOwnerId, "idempotency-first"),
      input,
    );
    const replay = await reportService.createReport(
      request(reporterOwnerId, "idempotency-replay"),
      input,
    );
    expect(replay).toMatchObject({
      created: false,
      deduplicated: false,
      replayed: true,
      report: { id: first.report.id },
    });
    await expect(
      reportService.createReport(request(reporterOwnerId, "idempotency-conflict"), {
        ...input,
        reasonCode: "spam",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      statusCode: 409,
    } satisfies Partial<ContentReportError>);
  });

  it("deduplicates concurrent reports from one Agent without extra Case weight", async () => {
    const contentId = await createContent("concurrent-deduplication");
    const firstInput = {
      contentId,
      idempotencyKey: `concurrent-a-${marker}`,
      reasonCode: "spam" as const,
      reporterActorId,
    };
    const duplicateInput = {
      contentId,
      idempotencyKey: `concurrent-b-${marker}`,
      reasonCode: "privacy_exposure" as const,
      reporterActorId,
    };
    const outcomes = await Promise.all([
      reportService.createReport(request(reporterOwnerId, "concurrent-a"), firstInput),
      reportService.createReport(
        request(reporterOwnerId, "concurrent-b"),
        duplicateInput,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.deduplicated)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.report.id)).size).toBe(1);

    const counts = await postgres.sql<{ cases: number; reports: number }[]>`
      select
        count(distinct moderation_case.id)::integer as cases,
        count(distinct report.id)::integer as reports
      from platform.moderation_cases as moderation_case
      join platform.moderation_case_items as item
        on item.case_id = moderation_case.id
      join platform.reports as report on report.id = item.report_id
      where moderation_case.target_content_id = ${contentId}
    `;
    expect(counts).toEqual([{ cases: 1, reports: 1 }]);

    const duplicateOutcome = outcomes.find((outcome) => outcome.deduplicated);
    if (!duplicateOutcome) throw new Error("A duplicate outcome was not returned");
    await postgres.sql`
      update platform.reports
      set version = version + 1,
          status = 'dismissed'
      where id = ${duplicateOutcome.report.id}
        and status = 'open'
    `;

    const replay = await reportService.createReport(
      request(reporterOwnerId, "concurrent-deduplicated-replay"),
      duplicateInput,
    );
    expect(replay).toMatchObject({
      created: false,
      deduplicated: false,
      replayed: true,
      report: {
        id: duplicateOutcome.report.id,
        status: "dismissed",
        version: 2,
      },
    });
    await expect(
      reportService.createReport(
        request(reporterOwnerId, "concurrent-deduplicated-conflict"),
        { ...duplicateInput, details: "different request digest" },
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      statusCode: 409,
    } satisfies Partial<ContentReportError>);

    const mappings = await postgres.sql<
      { details_leaked: boolean; mapping_count: number }[]
    >`
      select
        count(*)::integer as mapping_count,
        bool_or(to_jsonb(submission)::text like '%different request digest%')
          as details_leaked
      from platform.report_submission_idempotency as submission
      where submission.report_id = ${duplicateOutcome.report.id}
    `;
    expect(mappings).toEqual([{ details_leaked: false, mapping_count: 2 }]);
  });

  it("charges immutable duplicate aliases to the submitting Agent", async () => {
    const contentId = await createContent("duplicate-alias-quota");
    const submission = (index: number, actorId: string) => ({
      contentId,
      idempotencyKey: `alias-${index}-${marker}`,
      reasonCode: "spam" as const,
      reporterActorId: actorId,
    });

    const first = await reportService.createReport(
      request(aliasReporterOwnerId, "alias-0"),
      submission(0, aliasReporterActorId),
    );
    expect(first.created).toBe(true);

    for (let index = 1; index <= 5; index += 1) {
      const duplicate = await reportService.createReport(
        request(aliasReporterOwnerId, `alias-${index}`),
        submission(index, aliasReporterSiblingActorId),
      );
      expect(duplicate).toMatchObject({
        created: false,
        deduplicated: true,
        report: { id: first.report.id },
      });
    }

    await expect(
      reportService.createReport(
        request(aliasReporterOwnerId, "alias-limit"),
        submission(6, aliasReporterSiblingActorId),
      ),
    ).rejects.toMatchObject({
      code: "REPORT_LIMIT_REACHED",
      statusCode: 429,
    } satisfies Partial<ContentReportError>);

    const replay = await reportService.createReport(
      request(aliasReporterOwnerId, "alias-replay"),
      submission(5, aliasReporterSiblingActorId),
    );
    expect(replay).toMatchObject({
      created: false,
      deduplicated: false,
      replayed: true,
      report: { id: first.report.id },
    });

    const counts = await postgres.sql<
      { actor_id: string; mappings: number; reports: number }[]
    >`
      select
        submission.reporter_actor_id::text as actor_id,
        count(distinct submission.idempotency_key)::integer as mappings,
        count(distinct report.id)::integer as reports
      from platform.report_submission_idempotency as submission
      join platform.reports as report on report.id = submission.report_id
      where submission.reporter_owner_id = ${aliasReporterOwnerId}
        and report.target_content_id = ${contentId}
      group by submission.reporter_actor_id
      order by submission.reporter_actor_id
    `;
    expect(counts).toEqual(
      [
        { actor_id: aliasReporterActorId, mappings: 1, reports: 1 },
        { actor_id: aliasReporterSiblingActorId, mappings: 5, reports: 1 },
      ].sort((left, right) => left.actor_id.localeCompare(right.actor_id)),
    );
  });

  it("deduplicates active reports from two Agents owned by the same Owner", async () => {
    const contentId = await createContent("same-owner-deduplication");
    const first = await reportService.createReport(
      request(reporterOwnerId, "same-owner-first"),
      {
        contentId,
        idempotencyKey: `same-owner-first-${marker}`,
        reasonCode: "malicious_link",
        reporterActorId,
      },
    );
    const duplicate = await reportService.createReport(
      request(reporterOwnerId, "same-owner-sibling"),
      {
        contentId,
        idempotencyKey: `same-owner-sibling-${marker}`,
        reasonCode: "privacy_exposure",
        reporterActorId: reporterSiblingActorId,
      },
    );

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      deduplicated: true,
      replayed: false,
      report: { caseId: first.report.caseId, id: first.report.id },
    });

    const rows = await postgres.sql<
      {
        case_count: number;
        case_version: number;
        mapping_actors: string[];
        mapping_count: number;
        report_count: number;
      }[]
    >`
      select
        count(distinct moderation_case.id)::integer as case_count,
        max(moderation_case.version)::integer as case_version,
        array_agg(
          distinct submission.reporter_actor_id::text
          order by submission.reporter_actor_id::text
        ) as mapping_actors,
        count(distinct submission.idempotency_key)::integer as mapping_count,
        count(distinct report.id)::integer as report_count
      from platform.moderation_cases as moderation_case
      join platform.moderation_case_items as item
        on item.case_id = moderation_case.id
      join platform.reports as report on report.id = item.report_id
      join platform.report_submission_idempotency as submission
        on submission.report_id = report.id
      where moderation_case.target_content_id = ${contentId}
    `;
    expect(rows).toEqual([
      {
        case_count: 1,
        case_version: 1,
        mapping_actors: [reporterActorId, reporterSiblingActorId].sort(),
        mapping_count: 2,
        report_count: 1,
      },
    ]);
  });

  it("attaches a different Owner's report to the same active Case", async () => {
    const contentId = await createContent("case-aggregation");
    const first = await reportService.createReport(
      request(reporterOwnerId, "case-first"),
      {
        contentId,
        idempotencyKey: `case-first-${marker}`,
        reasonCode: "malicious_link",
        reporterActorId: reporterSiblingActorId,
      },
    );
    const second = await reportService.createReport(
      request(secondReporterOwnerId, "case-second"),
      {
        contentId,
        idempotencyKey: `case-second-${marker}`,
        reasonCode: "privacy_exposure",
        reporterActorId: secondReporterActorId,
      },
    );
    expect(second.created).toBe(true);
    expect(second.report.caseId).toBe(first.report.caseId);
    const rows = await postgres.sql<{ report_count: number; version: number }[]>`
      select
        moderation_case.version::integer as version,
        count(item.report_id)::integer as report_count
      from platform.moderation_cases as moderation_case
      join platform.moderation_case_items as item on item.case_id = moderation_case.id
      where moderation_case.id = ${first.report.caseId}
      group by moderation_case.id
    `;
    expect(rows).toEqual([{ report_count: 2, version: 2 }]);
  });

  it("rejects self-reporting without creating governance records", async () => {
    const contentId = await createContent("self-report");
    await expect(
      reportService.createReport(request(authorOwnerId, "self-report"), {
        contentId,
        idempotencyKey: `self-report-${marker}`,
        reasonCode: "spam",
        reporterActorId: authorActorId,
      }),
    ).rejects.toMatchObject({
      code: "SELF_REPORT_NOT_ALLOWED",
      statusCode: 409,
    } satisfies Partial<ContentReportError>);
    const counts = await postgres.sql<{ cases: number; reports: number }[]>`
      select
        (select count(*)::integer from platform.reports
         where target_content_id = ${contentId}) as reports,
        (select count(*)::integer from platform.moderation_cases
         where target_content_id = ${contentId}) as cases
    `;
    expect(counts).toEqual([{ cases: 0, reports: 0 }]);
  });

  it("rejects cross-Agent self-reporting by the same Owner", async () => {
    const contentId = await createContent("same-owner-self-report");
    await expect(
      reportService.createReport(request(authorOwnerId, "same-owner-self-report"), {
        contentId,
        idempotencyKey: `same-owner-self-report-${marker}`,
        reasonCode: "spam",
        reporterActorId: authorSiblingActorId,
      }),
    ).rejects.toMatchObject({
      code: "SELF_REPORT_NOT_ALLOWED",
      statusCode: 409,
    } satisfies Partial<ContentReportError>);
    const counts = await postgres.sql<{ cases: number; reports: number }[]>`
      select
        (select count(*)::integer from platform.reports
         where target_content_id = ${contentId}) as reports,
        (select count(*)::integer from platform.moderation_cases
         where target_content_id = ${contentId}) as cases
    `;
    expect(counts).toEqual([{ cases: 0, reports: 0 }]);
  });
});
