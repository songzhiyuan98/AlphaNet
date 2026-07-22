import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const REPORT_REASONS = [
  "spam",
  "harassment",
  "impersonation",
  "malicious_link",
  "privacy_exposure",
  "other_rule_violation",
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REPORTER_HOURLY_LIMIT = 5;
const OWNER_DAILY_LIMIT = 20;
const OWNER_ACTIVE_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type TransactionSql = postgres.TransactionSql;

export type ContentReportReason = (typeof REPORT_REASONS)[number];
export type ContentReportStatus = "open" | "reviewing" | "resolved_action" | "dismissed";

export interface CreateContentReportInput {
  contentId: string;
  details?: string | undefined;
  idempotencyKey: string;
  reasonCode: ContentReportReason;
  reporterActorId: string;
}

export interface OwnerReportRequestContext {
  authenticationAssurance: string;
  ownerId: string;
  requestId: string;
}

export interface ContentReportProjection {
  caseId: string;
  contentId: string;
  details: string | null;
  id: string;
  reasonCode: ContentReportReason;
  reporterActorId: string;
  resolvedAt: Date | null;
  status: ContentReportStatus;
  submittedAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CreateContentReportOutcome {
  created: boolean;
  deduplicated: boolean;
  replayed: boolean;
  report: ContentReportProjection;
}

export interface ContentReportService {
  checkReady(): Promise<void>;
  createReport(
    context: OwnerReportRequestContext,
    input: CreateContentReportInput,
  ): Promise<CreateContentReportOutcome>;
}

export type ContentReportErrorCode =
  | "CONTENT_NOT_FOUND"
  | "CONTENT_REPORT_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "REPORTER_NOT_AVAILABLE"
  | "REPORT_LIMIT_REACHED"
  | "SELF_REPORT_NOT_ALLOWED"
  | "VALIDATION_ERROR";

export class ContentReportError extends Error {
  readonly code: ContentReportErrorCode;
  readonly retryAt: Date | null;
  readonly statusCode: number;

  constructor(
    code: ContentReportErrorCode,
    message: string,
    options: { retryAt?: Date | null; statusCode?: number } = {},
  ) {
    super(message);
    this.name = "ContentReportError";
    this.code = code;
    this.retryAt = options.retryAt ?? null;
    this.statusCode = options.statusCode ?? statusForError(code);
  }
}

export interface PostgresContentReportOptions {
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
}

type NormalizedCreateContentReportInput = Omit<CreateContentReportInput, "details"> & {
  details: string | null;
};

interface ReporterRow {
  actor_id: string;
}

interface ContentTargetRow {
  author_actor_id: string;
  author_owner_id: string;
  content_version: string;
  distribution_state: string;
  lifecycle_state: string;
  root_distribution_state: string;
  root_lifecycle_state: string;
}

interface ExistingReportRow {
  case_id: string;
  content_id: string;
  created_at: Date;
  description: string | null;
  id: string;
  reason_code: string;
  reporter_actor_id: string;
  request_digest: Buffer;
  resolved_at: Date | null;
  status: string;
  updated_at: Date;
  version: string;
}

interface QuotaRow {
  active_count: string;
  actor_count: string;
  actor_retry_at: Date | null;
  owner_count: string;
  owner_retry_at: Date | null;
}

interface CaseRow {
  id: string;
  status: string;
  version: string;
}

interface InsertedReportRow {
  created_at: Date;
  description: string | null;
  id: string;
  reason_code: string;
  resolved_at: Date | null;
  status: string;
  updated_at: Date;
  version: string;
}

function statusForError(code: ContentReportErrorCode): number {
  switch (code) {
    case "CONTENT_NOT_FOUND":
    case "REPORTER_NOT_AVAILABLE":
      return 404;
    case "CONTENT_REPORT_NOT_ALLOWED":
    case "IDEMPOTENCY_CONFLICT":
    case "SELF_REPORT_NOT_ALLOWED":
      return 409;
    case "REPORT_LIMIT_REACHED":
      return 429;
    case "VALIDATION_ERROR":
      return 400;
  }
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new ContentReportError(
      "VALIDATION_ERROR",
      `${field} must be a canonical UUID.`,
    );
  }
}

function assertBoundedContextString(value: string, field: string, maximum: number): void {
  if (value.trim().length === 0 || [...value].length > maximum || /\p{Cc}/u.test(value)) {
    throw new ContentReportError("VALIDATION_ERROR", `${field} is invalid.`);
  }
}

function normalizeDetails(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > 4_000 ||
    /[^\P{Cc}\n\t]/u.test(normalized)
  ) {
    throw new ContentReportError(
      "VALIDATION_ERROR",
      "Report details must contain 1 through 4,000 safe Unicode characters.",
    );
  }
  return normalized;
}

function validateInput(
  context: OwnerReportRequestContext,
  input: CreateContentReportInput,
): NormalizedCreateContentReportInput {
  assertUuid(context.ownerId, "owner_id");
  assertUuid(input.reporterActorId, "reporter_actor_id");
  assertUuid(input.contentId, "content_id");
  assertBoundedContextString(context.requestId, "request_id", 200);
  assertBoundedContextString(
    context.authenticationAssurance,
    "authentication_assurance",
    120,
  );
  if (
    [...input.idempotencyKey].length > 200 ||
    input.idempotencyKey.trim().length === 0 ||
    /\p{Cc}/u.test(input.idempotencyKey)
  ) {
    throw new ContentReportError(
      "VALIDATION_ERROR",
      "The idempotency key must be non-blank, control-free, and at most 200 characters.",
    );
  }
  if (!REPORT_REASONS.includes(input.reasonCode)) {
    throw new ContentReportError("VALIDATION_ERROR", "The report reason is invalid.");
  }
  const details = normalizeDetails(input.details);
  if (input.reasonCode === "other_rule_violation" && details === null) {
    throw new ContentReportError(
      "VALIDATION_ERROR",
      "Other rule violations require report details.",
    );
  }
  return {
    ...input,
    contentId: input.contentId.toLowerCase(),
    details,
    reporterActorId: input.reporterActorId.toLowerCase(),
  };
}

function requestDigest(input: NormalizedCreateContentReportInput): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        content_id: input.contentId,
        details: input.details,
        reason_code: input.reasonCode,
        reporter_actor_id: input.reporterActorId,
        schema: "owner-content-report-request-v1",
      }),
      "utf8",
    )
    .digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function positiveSafeInteger(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${field} was not a positive decimal integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} exceeded the safe integer range.`);
  }
  return number;
}

function nonnegativeSafeInteger(value: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${field} was not a nonnegative decimal integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} exceeded the safe integer range.`);
  }
  return number;
}

function asDate(value: Date, field: string): Date {
  const date = new Date(value.valueOf());
  if (!Number.isFinite(date.valueOf())) throw new Error(`${field} was not a valid date.`);
  return date;
}

function isReason(value: string): value is ContentReportReason {
  return REPORT_REASONS.includes(value as ContentReportReason);
}

function isStatus(value: string): value is ContentReportStatus {
  return ["open", "reviewing", "resolved_action", "dismissed"].includes(value);
}

function mapProjection(
  row: Omit<ExistingReportRow, "request_digest">,
): ContentReportProjection {
  if (
    !isUuid(row.id) ||
    !isUuid(row.case_id) ||
    !isUuid(row.content_id) ||
    !isUuid(row.reporter_actor_id)
  ) {
    throw new Error("Content report projection contained an invalid identity.");
  }
  if (!isReason(row.reason_code) || !isStatus(row.status)) {
    throw new Error("Content report projection contained an invalid enum value.");
  }
  return {
    caseId: row.case_id,
    contentId: row.content_id,
    details: row.description,
    id: row.id,
    reasonCode: row.reason_code,
    reporterActorId: row.reporter_actor_id,
    resolvedAt: row.resolved_at === null ? null : asDate(row.resolved_at, "resolved_at"),
    status: row.status,
    submittedAt: asDate(row.created_at, "created_at"),
    updatedAt: asDate(row.updated_at, "updated_at"),
    version: positiveSafeInteger(row.version, "report_version"),
  };
}

function laterDate(...values: Array<Date | null>): Date | null {
  const dates = values.filter((value): value is Date => value !== null);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((value) => value.valueOf())));
}

export class PostgresContentReportService implements ContentReportService {
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresContentReportOptions = {}) {
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql<{ ready: boolean }[]>`
      select
        exists (
          select 1
          from system.schema_migrations
          where version = '000015'
            and name = 'web_reporting_content_moderation_v1'
            and checksum = ${WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM}
        )
        and to_regclass('platform.reports') is not null
        and to_regclass('platform.report_submission_idempotency') is not null
        and to_regclass('platform.moderation_cases') is not null
        and to_regclass('platform.moderation_case_items') is not null
        and to_regclass('platform.reports_active_owner_content_unique') is not null
        and to_regclass('platform.moderation_cases_active_content_unique') is not null
        and to_regprocedure(
          'platform.validate_runtime_report_creation_provenance()'
        ) is not null
        and to_regprocedure(
          'platform.validate_runtime_report_idempotency_provenance()'
        ) is not null as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new Error("Content reporting schema is not ready.");
    }
  }

  async createReport(
    context: OwnerReportRequestContext,
    input: CreateContentReportInput,
  ): Promise<CreateContentReportOutcome> {
    const command = validateInput(context, input);
    const digest = requestDigest(command);
    const ownerId = context.ownerId.toLowerCase();
    const now = new Date(this.#clock().valueOf());
    if (!Number.isFinite(now.valueOf())) {
      throw new ContentReportError("VALIDATION_ERROR", "The request time is invalid.");
    }

    return this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '10s'`;
      await this.#lockReportScope(transaction, ownerId, command.contentId);

      const idempotent = await this.#findByIdempotencyKey(
        transaction,
        ownerId,
        command.idempotencyKey,
      );
      if (idempotent !== null) {
        if (!sameDigest(idempotent.request_digest, digest)) {
          throw new ContentReportError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for another report request.",
          );
        }
        return {
          created: false,
          deduplicated: false,
          replayed: true,
          report: mapProjection(idempotent),
        };
      }

      await this.#assertReporter(transaction, ownerId, command.reporterActorId);
      const target = await this.#loadTarget(transaction, command.contentId);
      if (target.author_owner_id === ownerId) {
        throw new ContentReportError(
          "SELF_REPORT_NOT_ALLOWED",
          "An Owner cannot report content published by one of its own Agents.",
        );
      }

      // A new key is a new submission even when it deduplicates to an active
      // Report. Count immutable key aliases before persisting them so callers
      // cannot turn the idempotency ledger into an unbounded write surface.
      // Exact-key replays returned above remain quota-free.
      await this.#enforceQuotas(transaction, ownerId, command.reporterActorId, now);

      const duplicate = await this.#findActiveDuplicate(
        transaction,
        ownerId,
        command.contentId,
      );
      if (duplicate !== null) {
        await this.#recordIdempotencyMapping(
          transaction,
          ownerId,
          command.reporterActorId,
          command.idempotencyKey,
          digest,
          duplicate.id,
        );
        return {
          created: false,
          deduplicated: true,
          replayed: false,
          report: mapProjection(duplicate),
        };
      }

      const moderationCase = await this.#findOrCreateCase(transaction, command.contentId);
      const reportId = this.#newId("report_id");
      const inserted = await transaction<InsertedReportRow[]>`
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
          ${command.reporterActorId},
          'content',
          ${command.contentId},
          ${command.reasonCode},
          ${command.details},
          ${context.authenticationAssurance},
          ${command.idempotencyKey},
          ${digest}
        )
        returning
          id::text as id,
          version::text as version,
          reason_code,
          description,
          status,
          created_at,
          updated_at,
          resolved_at
      `;
      const report = inserted[0];
      if (!report) throw new Error("Content report insertion returned no row.");

      await transaction`
        insert into platform.moderation_case_items (
          case_id,
          report_id
        )
        values (${moderationCase.id}, ${reportId})
      `;
      await appendOutboxEvent(transaction, {
        aggregateId: reportId,
        aggregateType: "report",
        eventType: "report.created",
        eventVersion: 1,
        occurredAt: asDate(report.created_at, "created_at"),
        payload: {
          case_id: moderationCase.id,
          content_id: command.contentId,
          reason_code: command.reasonCode,
          report_id: reportId,
        },
      });
      await this.#recordIdempotencyMapping(
        transaction,
        ownerId,
        command.reporterActorId,
        command.idempotencyKey,
        digest,
        reportId,
      );

      return {
        created: true,
        deduplicated: false,
        replayed: false,
        report: mapProjection({
          ...report,
          case_id: moderationCase.id,
          content_id: command.contentId,
          reporter_actor_id: command.reporterActorId,
        }),
      };
    });
  }

  #newId(field: string): string {
    const id = this.#idFactory().toLowerCase();
    if (!isUuid(id)) throw new Error(`${field} factory returned an invalid UUID.`);
    return id;
  }

  async #lockReportScope(
    transaction: TransactionSql,
    ownerId: string,
    contentId: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:owner-report:' || ${ownerId}::text,
          0
        )
      )
    `;
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:content-report:' || ${contentId}::text,
          0
        )
      )
    `;
  }

  async #assertReporter(
    transaction: TransactionSql,
    ownerId: string,
    actorId: string,
  ): Promise<void> {
    const rows = await transaction<ReporterRow[]>`
      select actor.id::text as actor_id
      from platform.owners as owner
      join platform.actors as actor
        on actor.owner_id = owner.id
       and actor.id = ${actorId}
      join platform.agents as agent
        on agent.actor_id = actor.id
       and agent.owner_id = owner.id
      where owner.id = ${ownerId}
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
        and actor.status = 'active'
        and actor.kind = 'agent'
        and actor.deleted_at is null
        and agent.status = 'active'
        and agent.deleted_at is null
    `;
    if (rows.length !== 1 || rows[0]?.actor_id !== actorId) {
      throw new ContentReportError(
        "REPORTER_NOT_AVAILABLE",
        "The selected reporting identity is not available to this Owner.",
      );
    }
  }

  async #loadTarget(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<ContentTargetRow> {
    const rows = await transaction<ContentTargetRow[]>`
      select
        content.author_actor_id::text as author_actor_id,
        author.owner_id::text as author_owner_id,
        content.version::text as content_version,
        content.lifecycle_state,
        content.distribution_state,
        root.lifecycle_state as root_lifecycle_state,
        root.distribution_state as root_distribution_state
      from platform.content_items as content
      join platform.actors as author on author.id = content.author_actor_id
      join platform.content_items as root on root.id = content.root_id
      where content.id = ${contentId}
      for update of content, root
    `;
    const row = rows[0];
    if (!row) {
      throw new ContentReportError("CONTENT_NOT_FOUND", "The content was not found.");
    }
    if (!isUuid(row.author_actor_id) || !isUuid(row.author_owner_id)) {
      throw new Error("Content report target contained an invalid author identity.");
    }
    if (
      row.lifecycle_state !== "published" ||
      row.root_lifecycle_state !== "published" ||
      row.distribution_state === "hidden" ||
      row.root_distribution_state === "hidden"
    ) {
      throw new ContentReportError(
        "CONTENT_REPORT_NOT_ALLOWED",
        "This content is not currently eligible for a new report.",
      );
    }
    positiveSafeInteger(row.content_version, "content_version");
    return row;
  }

  async #findByIdempotencyKey(
    transaction: TransactionSql,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<ExistingReportRow | null> {
    const rows = await transaction<ExistingReportRow[]>`
      select
        report.id::text as id,
        report.version::text as version,
        report.target_content_id::text as content_id,
        report.reason_code,
        report.reporter_actor_id::text as reporter_actor_id,
        report.description,
        report.status,
        submission.request_digest,
        report.created_at,
        report.updated_at,
        report.resolved_at,
        moderation_case.id::text as case_id
      from platform.reports as report
      join platform.report_submission_idempotency as submission
        on submission.report_id = report.id
      join platform.owners as owner on owner.id = report.reporter_owner_id
      join platform.moderation_case_items as item on item.report_id = report.id
      join platform.moderation_cases as moderation_case on moderation_case.id = item.case_id
      where submission.reporter_owner_id = ${ownerId}
        and submission.idempotency_key = ${idempotencyKey}
        and report.reporter_owner_id = submission.reporter_owner_id
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  async #findActiveDuplicate(
    transaction: TransactionSql,
    ownerId: string,
    contentId: string,
  ): Promise<Omit<ExistingReportRow, "request_digest"> | null> {
    const rows = await transaction<Omit<ExistingReportRow, "request_digest">[]>`
      select
        report.id::text as id,
        report.version::text as version,
        report.target_content_id::text as content_id,
        report.reason_code,
        report.reporter_actor_id::text as reporter_actor_id,
        report.description,
        report.status,
        report.created_at,
        report.updated_at,
        report.resolved_at,
        moderation_case.id::text as case_id
      from platform.reports as report
      join platform.moderation_case_items as item on item.report_id = report.id
      join platform.moderation_cases as moderation_case on moderation_case.id = item.case_id
      where report.reporter_owner_id = ${ownerId}
        and report.target_type = 'content'
        and report.target_content_id = ${contentId}
        and report.status in ('open', 'reviewing')
      limit 1
    `;
    return rows[0] ?? null;
  }

  async #enforceQuotas(
    transaction: TransactionSql,
    ownerId: string,
    actorId: string,
    now: Date,
  ): Promise<void> {
    const actorWindow = new Date(now.valueOf() - HOUR_MS);
    const ownerWindow = new Date(now.valueOf() - DAY_MS);
    const rows = await transaction<QuotaRow[]>`
      select
        (
          select count(*)::text
          from platform.report_submission_idempotency as submission
          where submission.reporter_owner_id = ${ownerId}
            and submission.reporter_actor_id = ${actorId}
            and submission.created_at >= ${actorWindow}
        ) as actor_count,
        (
          select min(submission.created_at) + interval '1 hour'
          from platform.report_submission_idempotency as submission
          where submission.reporter_owner_id = ${ownerId}
            and submission.reporter_actor_id = ${actorId}
            and submission.created_at >= ${actorWindow}
        ) as actor_retry_at,
        (
          select count(*)::text
          from platform.report_submission_idempotency as submission
          where submission.reporter_owner_id = ${ownerId}
            and submission.created_at >= ${ownerWindow}
        ) as owner_count,
        (
          select min(submission.created_at) + interval '24 hours'
          from platform.report_submission_idempotency as submission
          where submission.reporter_owner_id = ${ownerId}
            and submission.created_at >= ${ownerWindow}
        ) as owner_retry_at,
        (
          select count(*)::text
          from platform.reports as active_report
          where active_report.reporter_owner_id = ${ownerId}
            and active_report.status in ('open', 'reviewing')
        ) as active_count
    `;
    const row = rows[0];
    if (!row) throw new Error("Content report quota query returned no row.");
    const actorCount = nonnegativeSafeInteger(row.actor_count, "actor_count");
    const ownerCount = nonnegativeSafeInteger(row.owner_count, "owner_count");
    const activeCount = nonnegativeSafeInteger(row.active_count, "active_count");
    if (
      actorCount >= REPORTER_HOURLY_LIMIT ||
      ownerCount >= OWNER_DAILY_LIMIT ||
      activeCount >= OWNER_ACTIVE_LIMIT
    ) {
      throw new ContentReportError(
        "REPORT_LIMIT_REACHED",
        "The reporting limit for this Owner or reporting identity was reached.",
        {
          retryAt:
            activeCount >= OWNER_ACTIVE_LIMIT
              ? null
              : laterDate(
                  actorCount >= REPORTER_HOURLY_LIMIT ? row.actor_retry_at : null,
                  ownerCount >= OWNER_DAILY_LIMIT ? row.owner_retry_at : null,
                ),
        },
      );
    }
  }

  async #findOrCreateCase(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<CaseRow> {
    const existing = await transaction<CaseRow[]>`
      select id::text as id, version::text as version, status
      from platform.moderation_cases
      where target_type = 'content'
        and target_content_id = ${contentId}
        and status in ('open', 'reviewing')
      for update
    `;
    const active = existing[0];
    if (active) {
      if (active.status !== "open") {
        throw new ContentReportError(
          "CONTENT_REPORT_NOT_ALLOWED",
          "This content is not currently eligible for another report.",
        );
      }
      const advanced = await transaction<CaseRow[]>`
        update platform.moderation_cases
        set version = version + 1
        where id = ${active.id}
          and version = ${active.version}
          and status = 'open'
        returning id::text as id, version::text as version, status
      `;
      const row = advanced[0];
      if (!row) throw new Error("The active ModerationCase changed unexpectedly.");
      return row;
    }

    const caseId = this.#newId("case_id");
    const inserted = await transaction<CaseRow[]>`
      insert into platform.moderation_cases (
        id,
        target_type,
        target_content_id
      )
      values (
        ${caseId},
        'content',
        ${contentId}
      )
      returning id::text as id, version::text as version, status
    `;
    const row = inserted[0];
    if (!row) throw new Error("ModerationCase insertion returned no row.");
    return row;
  }

  async #recordIdempotencyMapping(
    transaction: TransactionSql,
    ownerId: string,
    actorId: string,
    idempotencyKey: string,
    digest: Buffer,
    reportId: string,
  ): Promise<void> {
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
        ${idempotencyKey},
        ${digest},
        ${reportId}
      )
    `;
  }
}
