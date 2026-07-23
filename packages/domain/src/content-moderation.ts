import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { WEB_REPORTING_CONTENT_MODERATION_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const MAX_CURSOR_LENGTH = 4_096;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const CURSOR_VERSION = 1;

export const ADMIN_PERMISSIONS = [
  "moderation:read",
  "moderation:decide",
  "identity:restrict",
  "identity:quota_manage",
  "credential:revoke",
  "community:manage",
  "platform:operate",
  "audit:read",
  "admin:role_assign",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const CONTENT_REPORT_REASONS = [
  "spam",
  "harassment",
  "impersonation",
  "malicious_link",
  "privacy_exposure",
  "other_rule_violation",
] as const;
export type ModerationReportReason = (typeof CONTENT_REPORT_REASONS)[number];

export const CONTENT_MODERATION_ACTIONS = [
  "dismiss",
  "limit_content",
  "hide_content",
  "restore_content",
] as const;
export type ContentModerationAction = (typeof CONTENT_MODERATION_ACTIONS)[number];

export const ADMIN_MODERATION_REASON_CODES = [
  "confirmed_report_violation",
  "precautionary_distribution_limit",
  "insufficient_evidence",
  "no_rule_violation",
  "duplicate_case",
  "moderation_error_corrected",
  "appeal_granted",
  "risk_condition_resolved",
] as const;
export type AdminModerationReasonCode = (typeof ADMIN_MODERATION_REASON_CODES)[number];

export type ModerationCaseStatus = "open" | "reviewing" | "resolved_action" | "dismissed";
export type ModerationCasePriority = "normal" | "high" | "urgent";
export type ModeratedContentDistribution = "normal" | "limited" | "hidden";
export type ModeratedContentLifecycle = "published" | "deleted";
export type ModeratedContentKind = "post" | "reply";

export interface AdminMfaEvidence {
  amrMfa: boolean;
  matchedAcr: string | null;
  method: "acr" | "amr_mfa" | "acr_and_amr_mfa";
}

/**
 * Safe request-boundary evidence only. JWTs, OIDC claims, report details, and
 * internal notes are intentionally not accepted in this object.
 */
export interface AdminModerationContext {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: AdminMfaEvidence;
  permission: "moderation:read" | "moderation:decide";
  permissions: readonly AdminPermission[];
  requestId: string;
  roles: readonly string[];
}

export interface DecideModerationCaseInput {
  action: ContentModerationAction;
  expectedCaseVersion: number;
  idempotencyKey: string;
  internalNote?: string | undefined;
  reasonCode: AdminModerationReasonCode;
}

export interface ModerationAuthorView {
  actorId: string;
  agentId?: string | undefined;
  handle: string;
  kind: "agent" | "human";
}

export interface ModerationReasonCounts {
  harassment: number;
  impersonation: number;
  malicious_link: number;
  other_rule_violation: number;
  privacy_exposure: number;
  spam: number;
}

export interface ModerationCaseSummaryView {
  author: ModerationAuthorView;
  caseId: string;
  contentId: string;
  contentKind: ModeratedContentKind;
  contentVersion: number;
  distributionState: ModeratedContentDistribution;
  lastReportedAt: Date;
  latestActionId: string | null;
  lifecycleState: ModeratedContentLifecycle;
  openedAt: Date;
  priority: ModerationCasePriority;
  reasonCounts: ModerationReasonCounts;
  reportCount: number;
  resolutionAction: ContentModerationAction | null;
  resolvedAt: Date | null;
  status: ModerationCaseStatus;
  updatedAt: Date;
  version: number;
}

export interface ModerationCaseQueueItem extends ModerationCaseSummaryView {
  queueRank: number;
}

export interface ModerationContentSnapshotView {
  author: ModerationAuthorView;
  bodyMarkdown: string;
  contentId: string;
  createdAt: Date;
  currentRevisionId: string;
  deletedAt: Date | null;
  depth: number;
  distributionState: ModeratedContentDistribution;
  kind: ModeratedContentKind;
  lifecycleState: ModeratedContentLifecycle;
  parentContentId: string | null;
  resourceVersion: number;
  rootContentId: string;
  title: string | null;
  updatedAt: Date;
}

export interface AdminContentReportView {
  caseId: string;
  contentId: string;
  details: string | null;
  reasonCode: ModerationReportReason;
  reportId: string;
  reporterActorId: string;
  reporterOwnerId: string;
  resolvedAt: Date | null;
  status: ModerationCaseStatus;
  submittedAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ContentModerationActionRecord {
  action: ContentModerationAction;
  actionVersion: 1;
  caseId: string;
  contentLifecycleState: "published" | null;
  contentId: string;
  contentVersionAfter: number | null;
  contentVersionBefore: number | null;
  decidedAt: Date;
  decidedByAdminId: string;
  distributionAfter: ModeratedContentDistribution | null;
  distributionBefore: ModeratedContentDistribution | null;
  internalNote: string | null;
  moderationActionId: string;
  reasonCode: AdminModerationReasonCode;
  revertedActionId: string | null;
}

export type OwnerContentModerationRecord = Omit<
  ContentModerationActionRecord,
  "decidedByAdminId" | "internalNote"
>;

export interface CursorPage<T> {
  asOf: Date;
  hasMore: boolean;
  items: T[];
  limit: number;
  nextCursor: string | null;
  orderingVersion: string;
  snapshotId: string;
}

export interface ListModerationCasesInput {
  contentId?: string | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
  priorities?: readonly ModerationCasePriority[] | undefined;
  reasons?: readonly ModerationReportReason[] | undefined;
  statuses?: readonly ModerationCaseStatus[] | undefined;
}

export interface GetModerationCaseInput {
  actionCursor?: string | null | undefined;
  actionLimit?: number | undefined;
  reportCursor?: string | null | undefined;
  reportLimit?: number | undefined;
}

export interface ModerationCaseDetailView {
  actions: CursorPage<ContentModerationActionRecord>;
  case: ModerationCaseSummaryView;
  content: ModerationContentSnapshotView;
  reports: CursorPage<AdminContentReportView>;
}

export interface ModerationDecisionOutcome {
  action: ContentModerationActionRecord;
  case: ModerationCaseSummaryView;
  caseVersionBefore: number;
  content: {
    contentId: string;
    distributionState: ModeratedContentDistribution;
    lifecycleState: ModeratedContentLifecycle;
    resourceVersion: number;
  };
  replayed: boolean;
}

export interface ListOwnerContentModerationInput {
  cursor?: string | null | undefined;
  limit?: number | undefined;
}

export interface OwnerContentModerationHistoryView {
  contentId: string;
  contentVersion: number;
  distributionState: ModeratedContentDistribution;
  page: CursorPage<OwnerContentModerationRecord>;
}

export interface ContentModerationService {
  checkReady(): Promise<void>;
  decideCase(
    context: AdminModerationContext,
    caseId: string,
    input: DecideModerationCaseInput,
  ): Promise<ModerationDecisionOutcome>;
  getCase(
    context: AdminModerationContext,
    caseId: string,
    input: GetModerationCaseInput,
  ): Promise<ModerationCaseDetailView>;
  listCases(
    context: AdminModerationContext,
    input: ListModerationCasesInput,
  ): Promise<CursorPage<ModerationCaseQueueItem>>;
  listContentActions(
    ownerId: string,
    contentId: string,
    input: ListOwnerContentModerationInput,
  ): Promise<OwnerContentModerationHistoryView>;
}

export type ContentModerationErrorCode =
  | "ADMIN_AUTHENTICATION_REQUIRED"
  | "ADMIN_PERMISSION_REQUIRED"
  | "CASE_ASSIGNMENT_CONFLICT"
  | "CASE_NOT_ACTIONABLE"
  | "CASE_VERSION_CONFLICT"
  | "CONTENT_NOT_FOUND"
  | "CONTENT_STATE_CONFLICT"
  | "CURSOR_INVALID"
  | "DECISION_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "MODERATION_CASE_NOT_FOUND"
  | "MODERATION_UNAVAILABLE"
  | "OWNER_CONTENT_NOT_FOUND"
  | "RATE_LIMITED"
  | "VALIDATION_ERROR";

const errorDefinitions = {
  ADMIN_AUTHENTICATION_REQUIRED: [401, false, "Workforce authentication is required."],
  ADMIN_PERMISSION_REQUIRED: [
    403,
    false,
    "The required moderation permission is missing.",
  ],
  CASE_ASSIGNMENT_CONFLICT: [409, false, "The Case is assigned to another Admin."],
  CASE_NOT_ACTIONABLE: [409, false, "The Case can no longer accept a decision."],
  CASE_VERSION_CONFLICT: [
    409,
    false,
    "The Case changed before the decision was applied.",
  ],
  CONTENT_NOT_FOUND: [404, false, "The Case content target was not found."],
  CONTENT_STATE_CONFLICT: [409, false, "The Content state cannot accept this action."],
  CURSOR_INVALID: [422, false, "The moderation cursor is invalid or expired."],
  DECISION_NOT_ALLOWED: [
    422,
    false,
    "The moderation action and reason are incompatible.",
  ],
  IDEMPOTENCY_CONFLICT: [
    409,
    false,
    "The idempotency key was used for another decision.",
  ],
  MODERATION_CASE_NOT_FOUND: [404, false, "The moderation Case was not found."],
  MODERATION_UNAVAILABLE: [503, true, "Moderation is temporarily unavailable."],
  OWNER_CONTENT_NOT_FOUND: [404, false, "Content owned by this Owner was not found."],
  RATE_LIMITED: [429, true, "Too many moderation requests were made."],
  VALIDATION_ERROR: [422, false, "The moderation request is invalid."],
} as const satisfies Record<
  ContentModerationErrorCode,
  readonly [number, boolean, string]
>;

export class ContentModerationError extends Error {
  readonly code: ContentModerationErrorCode;
  readonly currentVersion: number | null;
  readonly retryAt: Date | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: ContentModerationErrorCode,
    options: {
      cause?: unknown;
      currentVersion?: number | null | undefined;
      retryAt?: Date | null | undefined;
    } = {},
  ) {
    const [statusCode, retryable, message] = errorDefinitions[code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContentModerationError";
    this.code = code;
    this.currentVersion = options.currentVersion ?? null;
    this.retryAt = options.retryAt ?? null;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export interface PostgresContentModerationOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Uint8Array;
  idFactory?: (() => string) | undefined;
}

type TransactionSql = postgres.TransactionSql;

interface AdminRbacRow {
  admin_id: string;
  permission: string;
  role_key: string;
}

interface CaseSummaryRow {
  actor_id: string;
  actor_kind: string;
  agent_id: string | null;
  case_id: string;
  case_version: string;
  closed_at: Date | null;
  content_id: string;
  content_kind: string;
  content_version: string;
  distribution_state: string;
  handle: string;
  harassment_count: string;
  impersonation_count: string;
  last_reported_at: Date;
  latest_action: string | null;
  latest_action_id: string | null;
  lifecycle_state: string;
  malicious_link_count: string;
  opened_at: Date;
  other_rule_violation_count: string;
  priority: string;
  privacy_exposure_count: string;
  report_count: string;
  spam_count: string;
  status: string;
  updated_at: Date;
}

interface ContentSnapshotRow {
  actor_id: string;
  actor_kind: string;
  agent_id: string | null;
  body_markdown: string;
  content_id: string;
  created_at: Date;
  current_revision_id: string;
  deleted_at: Date | null;
  depth: number;
  distribution_state: string;
  handle: string;
  kind: string;
  lifecycle_state: string;
  parent_id: string | null;
  root_id: string;
  title: string | null;
  updated_at: Date;
  version: string;
}

interface ActionRow {
  action: string;
  admin_id: string;
  after_distribution_state: string | null;
  before_distribution_state: string | null;
  case_closed_at_after: Date;
  case_id: string;
  case_updated_at_after: Date;
  case_version_after: string;
  case_version_before: string;
  content_id: string;
  id: string;
  internal_note: string | null;
  occurred_at: Date;
  reason_code: string;
  response_content_distribution_state: string;
  response_content_lifecycle_state: string;
  response_content_version: string;
  reverts_action_id: string | null;
  target_version_after: string | null;
  target_version_before: string | null;
  request_digest?: Buffer | undefined;
}

interface ReportRow {
  case_id: string;
  content_id: string;
  created_at: Date;
  description: string | null;
  id: string;
  reason_code: string;
  reporter_actor_id: string;
  reporter_owner_id: string;
  resolved_at: Date | null;
  status: string;
  updated_at: Date;
  version: string;
}

interface LockedCaseRow {
  assigned_admin_id: string | null;
  case_id: string;
  status: string;
  target_content_id: string | null;
  target_type: string;
  version: string;
}

interface CaseTargetRow {
  target_content_id: string | null;
  target_type: string;
}

interface LockedContentRow {
  current_revision_id: string;
  distribution_state: string;
  kind: string;
  lifecycle_state: string;
  root_id: string;
  version: string;
}

interface OwnerContentRow {
  content_id: string;
  distribution_state: string;
  version: string;
}

interface RestoreCandidateRow {
  id: string;
}

interface ListCursorPosition {
  activeRank: number;
  id: string;
  lastReportedAt: string;
  openedAt: string;
  priorityRank: number;
  queueRank: number;
}

interface DescendingCursorPosition {
  id: string;
  occurredAt: string;
}

interface CursorEnvelope<TFilters, TPosition> {
  asOf: string;
  filters: TFilters;
  position: TPosition;
  purpose: string;
  snapshotId: string;
  version: typeof CURSOR_VERSION;
}

interface NormalizedCaseFilters {
  contentId: string | null;
  limit: number;
  priorities: ModerationCasePriority[];
  reasons: ModerationReportReason[];
  statuses: ModerationCaseStatus[];
}

interface ValidatedAdminContext extends AdminModerationContext {
  adminId: string;
  permissions: AdminPermission[];
  roles: string[];
}

interface EffectiveAdminAuthorization {
  permissions: AdminPermission[];
  roles: string[];
}

const permissionSet = new Set<string>(ADMIN_PERMISSIONS);
const reportReasonSet = new Set<string>(CONTENT_REPORT_REASONS);
const actionSet = new Set<string>(CONTENT_MODERATION_ACTIONS);
const reasonSet = new Set<string>(ADMIN_MODERATION_REASON_CODES);
const caseStatusSet = new Set<string>([
  "open",
  "reviewing",
  "resolved_action",
  "dismissed",
]);
const prioritySet = new Set<string>(["normal", "high", "urgent"]);
const distributionSet = new Set<string>(["normal", "limited", "hidden"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function normalizeUuid(value: string, field: string): string {
  void field;
  if (!isUuid(value)) throw new ContentModerationError("VALIDATION_ERROR");
  return value.toLowerCase();
}

function positiveInteger(value: string, field: string): number {
  if (!POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new Error(`${field} is not a positive decimal integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} exceeds the safe integer range.`);
  }
  return number;
}

function nonnegativeInteger(value: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${field} is not a nonnegative decimal integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} exceeds the safe integer range.`);
  }
  return number;
}

function copyDate(value: Date, field: string): Date {
  const date = new Date(value.valueOf());
  if (!Number.isFinite(date.valueOf())) throw new Error(`${field} is not a valid date.`);
  return date;
}

function assertRequestId(value: string): void {
  if (
    value.trim() !== value ||
    value.length < 1 ||
    [...value].length > 200 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
}

function normalizeIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    [...value].length > 200 ||
    /\p{Cc}/u.test(value) ||
    value.includes(",")
  ) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  return value;
}

function normalizeInternalNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > 4_000 ||
    new TextEncoder().encode(normalized).byteLength > 16_384 ||
    /[^\P{Cc}\n\t]/u.test(normalized)
  ) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  return normalized;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function validateAdminContext(
  context: AdminModerationContext,
  requiredPermission: "moderation:read" | "moderation:decide",
): ValidatedAdminContext {
  if (
    !isPlainRecord(context) ||
    !hasExactKeys(context, [
      "adminId",
      "authenticationAssurance",
      "mfa",
      "permission",
      "permissions",
      "requestId",
      "roles",
    ]) ||
    context.authenticationAssurance !== "workforce_oidc" ||
    context.permission !== requiredPermission
  ) {
    throw new ContentModerationError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  if (!isUuid(context.adminId)) {
    throw new ContentModerationError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  const adminId = context.adminId.toLowerCase();
  assertRequestId(context.requestId);
  if (
    !isPlainRecord(context.mfa) ||
    !hasExactKeys(context.mfa, ["amrMfa", "matchedAcr", "method"]) ||
    typeof context.mfa.amrMfa !== "boolean" ||
    (context.mfa.matchedAcr !== null &&
      (typeof context.mfa.matchedAcr !== "string" ||
        context.mfa.matchedAcr.length < 1 ||
        context.mfa.matchedAcr.length > 200 ||
        context.mfa.matchedAcr.trim() !== context.mfa.matchedAcr ||
        /\p{Cc}/u.test(context.mfa.matchedAcr))) ||
    !["acr", "amr_mfa", "acr_and_amr_mfa"].includes(context.mfa.method) ||
    (context.mfa.method === "acr" &&
      (context.mfa.matchedAcr === null || context.mfa.amrMfa)) ||
    (context.mfa.method === "amr_mfa" &&
      (!context.mfa.amrMfa || context.mfa.matchedAcr !== null)) ||
    (context.mfa.method === "acr_and_amr_mfa" &&
      (!context.mfa.amrMfa || context.mfa.matchedAcr === null))
  ) {
    throw new ContentModerationError("ADMIN_AUTHENTICATION_REQUIRED");
  }
  if (
    !Array.isArray(context.permissions) ||
    context.permissions.length > ADMIN_PERMISSIONS.length ||
    new Set(context.permissions).size !== context.permissions.length ||
    context.permissions.some(
      (permission) => typeof permission !== "string" || !permissionSet.has(permission),
    ) ||
    !context.permissions.includes(requiredPermission) ||
    !Array.isArray(context.roles) ||
    context.roles.length > 100 ||
    new Set(context.roles).size !== context.roles.length ||
    context.roles.some((role) => typeof role !== "string" || !ROLE_PATTERN.test(role))
  ) {
    throw new ContentModerationError("ADMIN_PERMISSION_REQUIRED");
  }
  return {
    ...context,
    adminId,
    permissions: sortedUnique(
      Array.from(context.permissions as readonly AdminPermission[]),
    ),
    roles: sortedUnique(Array.from(context.roles as readonly string[])),
  };
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  return limit;
}

function validateUniqueEnums<T extends string>(
  values: readonly T[] | undefined,
  allowed: ReadonlySet<string>,
  defaults: readonly T[],
): T[] {
  if (values === undefined) return [...defaults];
  if (
    values.length < 1 ||
    values.length > allowed.size ||
    new Set(values).size !== values.length ||
    values.some((value) => !allowed.has(value))
  ) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  return sortedUnique(values);
}

function normalizeCaseFilters(input: ListModerationCasesInput): NormalizedCaseFilters {
  return {
    contentId:
      input.contentId === undefined ? null : normalizeUuid(input.contentId, "content_id"),
    limit: validateLimit(input.limit),
    priorities: validateUniqueEnums(input.priorities, prioritySet, [
      "normal",
      "high",
      "urgent",
    ] as const),
    reasons: validateUniqueEnums(input.reasons, reportReasonSet, [] as const),
    statuses: validateUniqueEnums(input.statuses, caseStatusSet, [
      "open",
      "reviewing",
    ] as const),
  };
}

function validateDecisionInput(input: DecideModerationCaseInput): {
  action: ContentModerationAction;
  expectedCaseVersion: number;
  idempotencyKey: string;
  internalNote: string | null;
  reasonCode: AdminModerationReasonCode;
} {
  if (
    !Number.isSafeInteger(input.expectedCaseVersion) ||
    input.expectedCaseVersion < 1 ||
    !actionSet.has(input.action) ||
    !reasonSet.has(input.reasonCode)
  ) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  const allowed =
    input.action === "dismiss"
      ? ["insufficient_evidence", "no_rule_violation", "duplicate_case"]
      : input.action === "restore_content"
        ? ["moderation_error_corrected", "appeal_granted", "risk_condition_resolved"]
        : ["confirmed_report_violation", "precautionary_distribution_limit"];
  if (!allowed.includes(input.reasonCode)) {
    throw new ContentModerationError("DECISION_NOT_ALLOWED");
  }
  return {
    action: input.action,
    expectedCaseVersion: input.expectedCaseVersion,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    internalNote: normalizeInternalNote(input.internalNote),
    reasonCode: input.reasonCode,
  };
}

function decisionDigest(
  caseId: string,
  input: ReturnType<typeof validateDecisionInput>,
): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: input.action,
        case_id: caseId,
        expected_case_version: input.expectedCaseVersion,
        internal_note: input.internalNote,
        reason_code: input.reasonCode,
        schema: "admin-content-moderation-decision-v1",
      }),
      "utf8",
    )
    .digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function mapAuthor(
  row: Pick<CaseSummaryRow, "actor_id" | "actor_kind" | "agent_id" | "handle">,
): ModerationAuthorView {
  if (!isUuid(row.actor_id) || (row.agent_id !== null && !isUuid(row.agent_id))) {
    throw new Error("Moderation author contains an invalid identity.");
  }
  if (row.actor_kind !== "agent" && row.actor_kind !== "human") {
    throw new Error("Moderation author contains an invalid kind.");
  }
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/u.test(row.handle)) {
    throw new Error("Moderation author contains an invalid handle.");
  }
  return {
    actorId: row.actor_id,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    handle: row.handle,
    kind: row.actor_kind,
  };
}

function isCaseStatus(value: string): value is ModerationCaseStatus {
  return caseStatusSet.has(value);
}

function isPriority(value: string): value is ModerationCasePriority {
  return prioritySet.has(value);
}

function isDistribution(value: string): value is ModeratedContentDistribution {
  return distributionSet.has(value);
}

function isAction(value: string | null): value is ContentModerationAction {
  return value !== null && actionSet.has(value);
}

function isReason(value: string): value is AdminModerationReasonCode {
  return reasonSet.has(value);
}

function isReportReason(value: string): value is ModerationReportReason {
  return reportReasonSet.has(value);
}

function mapCaseSummary(row: CaseSummaryRow): ModerationCaseSummaryView {
  if (
    !isUuid(row.case_id) ||
    !isUuid(row.content_id) ||
    (row.latest_action_id !== null && !isUuid(row.latest_action_id)) ||
    !isCaseStatus(row.status) ||
    !isPriority(row.priority) ||
    !isDistribution(row.distribution_state) ||
    (row.lifecycle_state !== "published" && row.lifecycle_state !== "deleted") ||
    (row.content_kind !== "post" && row.content_kind !== "reply") ||
    (row.latest_action !== null && !isAction(row.latest_action))
  ) {
    throw new Error("Moderation Case projection contains invalid data.");
  }
  return {
    author: mapAuthor(row),
    caseId: row.case_id,
    contentId: row.content_id,
    contentKind: row.content_kind,
    contentVersion: positiveInteger(row.content_version, "content_version"),
    distributionState: row.distribution_state,
    lastReportedAt: copyDate(row.last_reported_at, "last_reported_at"),
    latestActionId: row.latest_action_id,
    lifecycleState: row.lifecycle_state,
    openedAt: copyDate(row.opened_at, "opened_at"),
    priority: row.priority,
    reasonCounts: {
      harassment: nonnegativeInteger(row.harassment_count, "harassment_count"),
      impersonation: nonnegativeInteger(row.impersonation_count, "impersonation_count"),
      malicious_link: nonnegativeInteger(
        row.malicious_link_count,
        "malicious_link_count",
      ),
      other_rule_violation: nonnegativeInteger(
        row.other_rule_violation_count,
        "other_rule_violation_count",
      ),
      privacy_exposure: nonnegativeInteger(
        row.privacy_exposure_count,
        "privacy_exposure_count",
      ),
      spam: nonnegativeInteger(row.spam_count, "spam_count"),
    },
    reportCount: positiveInteger(row.report_count, "report_count"),
    resolutionAction: row.latest_action,
    resolvedAt: row.closed_at === null ? null : copyDate(row.closed_at, "closed_at"),
    status: row.status,
    updatedAt: copyDate(row.updated_at, "updated_at"),
    version: positiveInteger(row.case_version, "case_version"),
  };
}

function mapContentSnapshot(row: ContentSnapshotRow): ModerationContentSnapshotView {
  if (
    !isUuid(row.content_id) ||
    !isUuid(row.current_revision_id) ||
    !isUuid(row.root_id) ||
    (row.parent_id !== null && !isUuid(row.parent_id)) ||
    (row.kind !== "post" && row.kind !== "reply") ||
    (row.lifecycle_state !== "published" && row.lifecycle_state !== "deleted") ||
    !isDistribution(row.distribution_state)
  ) {
    throw new Error("Moderation Content projection contains invalid data.");
  }
  return {
    author: mapAuthor(row),
    bodyMarkdown: row.body_markdown,
    contentId: row.content_id,
    createdAt: copyDate(row.created_at, "created_at"),
    currentRevisionId: row.current_revision_id,
    deletedAt: row.deleted_at === null ? null : copyDate(row.deleted_at, "deleted_at"),
    depth: row.depth,
    distributionState: row.distribution_state,
    kind: row.kind,
    lifecycleState: row.lifecycle_state,
    parentContentId: row.parent_id,
    resourceVersion: positiveInteger(row.version, "content_version"),
    rootContentId: row.root_id,
    title: row.title,
    updatedAt: copyDate(row.updated_at, "updated_at"),
  };
}

function mapAction(row: ActionRow): ContentModerationActionRecord {
  if (
    !isUuid(row.id) ||
    !isUuid(row.case_id) ||
    !isUuid(row.content_id) ||
    !isUuid(row.admin_id) ||
    (row.reverts_action_id !== null && !isUuid(row.reverts_action_id)) ||
    !isAction(row.action) ||
    !isReason(row.reason_code) ||
    (row.before_distribution_state !== null &&
      !isDistribution(row.before_distribution_state)) ||
    (row.after_distribution_state !== null &&
      !isDistribution(row.after_distribution_state))
  ) {
    throw new Error("Moderation action projection contains invalid data.");
  }
  return {
    action: row.action,
    actionVersion: 1,
    caseId: row.case_id,
    contentLifecycleState: row.action === "dismiss" ? null : "published",
    contentId: row.content_id,
    contentVersionAfter:
      row.target_version_after === null
        ? null
        : positiveInteger(row.target_version_after, "target_version_after"),
    contentVersionBefore:
      row.target_version_before === null
        ? null
        : positiveInteger(row.target_version_before, "target_version_before"),
    decidedAt: copyDate(row.occurred_at, "occurred_at"),
    decidedByAdminId: row.admin_id,
    distributionAfter: row.after_distribution_state,
    distributionBefore: row.before_distribution_state,
    internalNote: row.internal_note,
    moderationActionId: row.id,
    reasonCode: row.reason_code,
    revertedActionId: row.reverts_action_id,
  };
}

function mapReport(row: ReportRow): AdminContentReportView {
  if (
    !isUuid(row.id) ||
    !isUuid(row.case_id) ||
    !isUuid(row.content_id) ||
    !isUuid(row.reporter_actor_id) ||
    !isUuid(row.reporter_owner_id) ||
    !isReportReason(row.reason_code) ||
    !isCaseStatus(row.status)
  ) {
    throw new Error("Moderation Report projection contains invalid data.");
  }
  return {
    caseId: row.case_id,
    contentId: row.content_id,
    details: row.description,
    reasonCode: row.reason_code,
    reportId: row.id,
    reporterActorId: row.reporter_actor_id,
    reporterOwnerId: row.reporter_owner_id,
    resolvedAt:
      row.resolved_at === null ? null : copyDate(row.resolved_at, "resolved_at"),
    status: row.status,
    submittedAt: copyDate(row.created_at, "created_at"),
    updatedAt: copyDate(row.updated_at, "updated_at"),
    version: positiveInteger(row.version, "report_version"),
  };
}

function ownerAction(row: ActionRow): OwnerContentModerationRecord {
  const { decidedByAdminId: _admin, internalNote: _note, ...safe } = mapAction(row);
  void _admin;
  void _note;
  return safe;
}

function priorityRank(priority: ModerationCasePriority): number {
  return priority === "urgent" ? 0 : priority === "high" ? 1 : 2;
}

function activeRank(status: ModerationCaseStatus): number {
  return status === "open" || status === "reviewing" ? 0 : 1;
}

function resolutionCode(
  action: ContentModerationAction,
  reasonCode: AdminModerationReasonCode,
): string {
  if (action === "dismiss") return reasonCode;
  if (action === "limit_content") return "content_limited";
  if (action === "hide_content") return "content_hidden";
  return "content_restored";
}

function caseStatusForAction(action: ContentModerationAction): ModerationCaseStatus {
  return action === "dismiss" ? "dismissed" : "resolved_action";
}

function actionAuditName(action: ContentModerationAction): string {
  return `moderation.${action}`;
}

function canonicalFilters(filters: NormalizedCaseFilters): Record<string, unknown> {
  return {
    content_id: filters.contentId,
    limit: filters.limit,
    priorities: filters.priorities,
    reasons: filters.reasons,
    statuses: filters.statuses,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) return null;
  return date;
}

function isDescendingPosition(value: unknown): value is DescendingCursorPosition {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["id", "occurredAt"]) &&
    typeof value.id === "string" &&
    isUuid(value.id) &&
    parseIsoDate(value.occurredAt) !== null
  );
}

function isListPosition(value: unknown): value is ListCursorPosition {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "activeRank",
      "id",
      "lastReportedAt",
      "openedAt",
      "priorityRank",
      "queueRank",
    ]) &&
    typeof value.id === "string" &&
    isUuid(value.id) &&
    Number.isSafeInteger(value.activeRank) &&
    (value.activeRank === 0 || value.activeRank === 1) &&
    Number.isSafeInteger(value.priorityRank) &&
    typeof value.priorityRank === "number" &&
    value.priorityRank >= 0 &&
    value.priorityRank <= 2 &&
    Number.isSafeInteger(value.queueRank) &&
    typeof value.queueRank === "number" &&
    value.queueRank >= 1 &&
    parseIsoDate(value.lastReportedAt) !== null &&
    parseIsoDate(value.openedAt) !== null
  );
}

function decodeCursorEnvelope<TFilters, TPosition>(
  cursor: string,
  signingKey: Buffer,
  purpose: string,
  filters: TFilters,
  positionGuard: (value: unknown) => value is TPosition,
): CursorEnvelope<TFilters, TPosition> {
  if (cursor.length < 3 || cursor.length > MAX_CURSOR_LENGTH || /\s/u.test(cursor)) {
    throw new ContentModerationError("CURSOR_INVALID");
  }
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ContentModerationError("CURSOR_INVALID");
  }
  const expected = createHmac("sha256", signingKey).update(parts[0]).digest();
  let actual: Buffer;
  let parsed: unknown;
  try {
    actual = Buffer.from(parts[1], "base64url");
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new ContentModerationError("CURSOR_INVALID");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ContentModerationError("CURSOR_INVALID");
  }
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, [
      "asOf",
      "filters",
      "position",
      "purpose",
      "snapshotId",
      "version",
    ]) ||
    parsed.version !== CURSOR_VERSION ||
    parsed.purpose !== purpose ||
    typeof parsed.snapshotId !== "string" ||
    !isUuid(parsed.snapshotId) ||
    parseIsoDate(parsed.asOf) === null ||
    !sameJson(parsed.filters, filters) ||
    !positionGuard(parsed.position)
  ) {
    throw new ContentModerationError("CURSOR_INVALID");
  }
  return parsed as unknown as CursorEnvelope<TFilters, TPosition>;
}

function encodeCursor<TFilters, TPosition>(
  envelope: CursorEnvelope<TFilters, TPosition>,
  signingKey: Buffer,
): string {
  const payload = Buffer.from(stableJson(envelope), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validClockDate(clock: () => Date): Date {
  const date = new Date(clock().valueOf());
  if (!Number.isFinite(date.valueOf())) {
    throw new ContentModerationError("VALIDATION_ERROR");
  }
  return date;
}

export class PostgresContentModerationService implements ContentModerationService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #idFactory: () => string;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresContentModerationOptions) {
    if (
      !(options.cursorSigningKey instanceof Uint8Array) ||
      options.cursorSigningKey.byteLength < 32
    ) {
      throw new Error(
        "The moderation cursor signing key must contain at least 32 bytes.",
      );
    }
    this.#sql = sql;
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
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
        and to_regclass('platform.admins') is not null
        and to_regclass('platform.admin_assignments') is not null
        and to_regclass('platform.reports') is not null
        and to_regclass('platform.moderation_cases') is not null
        and to_regclass('platform.moderation_case_items') is not null
        and to_regclass('platform.moderation_actions') is not null
        and to_regclass(
          'platform.moderation_actions_admin_idempotency_unique'
        ) is not null
        and to_regclass(
          'platform.moderation_actions_case_resolution_unique'
        ) is not null
        and to_regclass(
          'platform.moderation_actions_case_restore_unique'
        ) is not null
        and to_regclass(
          'platform.moderation_actions_reverted_action_unique'
        ) is not null
        and to_regprocedure(
          'platform.validate_runtime_moderation_action_provenance()'
        ) is not null
        and to_regprocedure(
          'platform.validate_runtime_moderation_resolution_provenance()'
        ) is not null
        and to_regprocedure(
          'platform.validate_runtime_governance_outbox_provenance()'
        ) is not null
        and to_regprocedure(
          'platform.validate_runtime_governance_action_log_provenance()'
        ) is not null
        and exists (
          select 1
          from pg_catalog.pg_trigger
          where tgrelid = to_regclass('platform.moderation_actions')
            and tgname = 'moderation_actions_validate_runtime_provenance'
            and tgfoid = to_regprocedure(
              'platform.validate_runtime_moderation_action_provenance()'
            )
            and tgdeferrable
            and tginitdeferred
            and not tgisinternal
            and tgenabled in ('O', 'A')
        )
        and exists (
          select 1
          from pg_catalog.pg_trigger
          where tgrelid = to_regclass('system.outbox_events')
            and tgname = 'outbox_events_validate_governance_provenance'
            and tgfoid = to_regprocedure(
              'platform.validate_runtime_governance_outbox_provenance()'
            )
            and tgdeferrable
            and tginitdeferred
            and not tgisinternal
            and tgenabled in ('O', 'A')
        )
        and exists (
          select 1
          from pg_catalog.pg_trigger
          where tgrelid = to_regclass('platform.action_logs')
            and tgname = 'action_logs_validate_governance_provenance'
            and tgfoid = to_regprocedure(
              'platform.validate_runtime_governance_action_log_provenance()'
            )
            and tgdeferrable
            and tginitdeferred
            and not tgisinternal
            and tgenabled in ('O', 'A')
        ) as ready
    `;
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new Error("Content moderation schema is not ready.");
    }
  }

  async listCases(
    context: AdminModerationContext,
    input: ListModerationCasesInput,
  ): Promise<CursorPage<ModerationCaseQueueItem>> {
    const admin = validateAdminContext(context, "moderation:read");
    const filters = normalizeCaseFilters(input);
    const purpose = "alphanet.admin.moderation-case-list.v1";
    const cursorFilters = canonicalFilters(filters);
    const cursor =
      input.cursor === undefined || input.cursor === null
        ? null
        : decodeCursorEnvelope(
            input.cursor,
            this.#cursorSigningKey,
            purpose,
            cursorFilters,
            isListPosition,
          );
    const asOf = cursor ? new Date(cursor.asOf) : validClockDate(this.#clock);
    const snapshotId = cursor?.snapshotId ?? this.#newId("snapshot_id");
    const position = cursor?.position ?? null;

    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          await this.#revalidateAdmin(transaction, admin, "moderation:read");
          const rows = await this.#queryCaseSummaries(transaction, {
            asOf,
            filters,
            limit: filters.limit + 1,
            position,
          });
          const hasMore = rows.length > filters.limit;
          const visibleRows = rows.slice(0, filters.limit);
          const baseRank = position?.queueRank ?? 0;
          const items = visibleRows.map((row, index) => ({
            ...mapCaseSummary(row),
            queueRank: baseRank + index + 1,
          }));
          const last = items.at(-1);
          const nextCursor =
            hasMore && last
              ? encodeCursor(
                  {
                    asOf: asOf.toISOString(),
                    filters: cursorFilters,
                    position: {
                      activeRank: activeRank(last.status),
                      id: last.caseId,
                      lastReportedAt: last.lastReportedAt.toISOString(),
                      openedAt: last.openedAt.toISOString(),
                      priorityRank: priorityRank(last.priority),
                      queueRank: last.queueRank,
                    },
                    purpose,
                    snapshotId,
                    version: CURSOR_VERSION,
                  },
                  this.#cursorSigningKey,
                )
              : null;
          return {
            asOf,
            hasMore,
            items,
            limit: filters.limit,
            nextCursor,
            orderingVersion: "moderation-case-live-keyset-v1",
            snapshotId,
          };
        },
      );
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  async getCase(
    context: AdminModerationContext,
    caseIdValue: string,
    input: GetModerationCaseInput,
  ): Promise<ModerationCaseDetailView> {
    const admin = validateAdminContext(context, "moderation:read");
    const caseId = normalizeUuid(caseIdValue, "case_id");
    const reportLimit = validateLimit(input.reportLimit);
    const actionLimit = validateLimit(input.actionLimit);
    const reportPurpose = "alphanet.admin.moderation-case-reports.v1";
    const actionPurpose = "alphanet.admin.moderation-case-actions.v1";
    const reportFilters = { case_id: caseId, limit: reportLimit };
    const actionFilters = { case_id: caseId, limit: actionLimit };
    const reportCursor =
      input.reportCursor === undefined || input.reportCursor === null
        ? null
        : decodeCursorEnvelope(
            input.reportCursor,
            this.#cursorSigningKey,
            reportPurpose,
            reportFilters,
            isDescendingPosition,
          );
    const actionCursor =
      input.actionCursor === undefined || input.actionCursor === null
        ? null
        : decodeCursorEnvelope(
            input.actionCursor,
            this.#cursorSigningKey,
            actionPurpose,
            actionFilters,
            isDescendingPosition,
          );
    const asOf = reportCursor
      ? new Date(reportCursor.asOf)
      : actionCursor
        ? new Date(actionCursor.asOf)
        : validClockDate(this.#clock);
    if (
      (reportCursor && reportCursor.asOf !== asOf.toISOString()) ||
      (actionCursor && actionCursor.asOf !== asOf.toISOString())
    ) {
      throw new ContentModerationError("CURSOR_INVALID");
    }
    const snapshotId =
      reportCursor?.snapshotId ?? actionCursor?.snapshotId ?? this.#newId("snapshot_id");
    if (
      (reportCursor && reportCursor.snapshotId !== snapshotId) ||
      (actionCursor && actionCursor.snapshotId !== snapshotId)
    ) {
      throw new ContentModerationError("CURSOR_INVALID");
    }

    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const effective = await this.#revalidateAdmin(
            transaction,
            admin,
            "moderation:read",
          );
          const summaries = await this.#queryCaseSummaries(transaction, {
            asOf,
            filters: {
              contentId: null,
              limit: 1,
              priorities: ["normal", "high", "urgent"],
              reasons: [],
              statuses: ["open", "reviewing", "resolved_action", "dismissed"],
            },
            limit: 1,
            position: null,
            requestedCaseId: caseId,
          });
          const summaryRow = summaries[0];
          if (!summaryRow) {
            throw new ContentModerationError("MODERATION_CASE_NOT_FOUND");
          }
          const contentRows = await this.#loadContentSnapshot(
            transaction,
            summaryRow.content_id,
          );
          const contentRow = contentRows[0];
          if (!contentRow) throw new ContentModerationError("CONTENT_NOT_FOUND");
          const reportRows = await this.#listReports(
            transaction,
            caseId,
            asOf,
            reportCursor?.position ?? null,
            reportLimit + 1,
          );
          const actionRows = await this.#listActions(
            transaction,
            caseId,
            asOf,
            actionCursor?.position ?? null,
            actionLimit + 1,
          );
          await this.#writeSensitiveReadAudit(transaction, {
            admin,
            authorization: effective,
            caseId,
            now: validClockDate(this.#clock),
          });
          return {
            actions: this.#descendingPage(
              actionRows,
              actionLimit,
              asOf,
              snapshotId,
              actionPurpose,
              actionFilters,
              mapAction,
              "moderation-action-list-v1",
            ),
            case: mapCaseSummary(summaryRow),
            content: mapContentSnapshot(contentRow),
            reports: this.#descendingPage(
              reportRows,
              reportLimit,
              asOf,
              snapshotId,
              reportPurpose,
              reportFilters,
              mapReport,
              "moderation-report-list-v1",
            ),
          };
        },
      );
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  async decideCase(
    context: AdminModerationContext,
    caseIdValue: string,
    input: DecideModerationCaseInput,
  ): Promise<ModerationDecisionOutcome> {
    const admin = validateAdminContext(context, "moderation:decide");
    const caseId = normalizeUuid(caseIdValue, "case_id");
    const decision = validateDecisionInput(input);
    const digest = decisionDigest(caseId, decision);
    try {
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const effective = await this.#revalidateAdmin(
          transaction,
          admin,
          "moderation:decide",
        );
        await this.#lockIdempotencyScope(
          transaction,
          admin.adminId,
          decision.idempotencyKey,
        );
        const replay = await this.#findDecisionReplay(
          transaction,
          admin.adminId,
          decision.idempotencyKey,
        );
        if (replay !== null) {
          if (
            !replay.action.request_digest ||
            !sameDigest(replay.action.request_digest, digest)
          ) {
            throw new ContentModerationError("IDEMPOTENCY_CONFLICT");
          }
          return this.#decisionOutcome(transaction, replay.action, replay.caseId, true);
        }

        const targetRows = await transaction<CaseTargetRow[]>`
          select
            case_target.target_type,
            case_target.target_content_id::text as target_content_id
          from platform.moderation_cases as case_target
          where case_target.id = ${caseId}
        `;
        const caseTarget = targetRows[0];
        if (!caseTarget) {
          throw new ContentModerationError("MODERATION_CASE_NOT_FOUND");
        }
        if (
          caseTarget.target_type !== "content" ||
          !caseTarget.target_content_id ||
          !isUuid(caseTarget.target_content_id)
        ) {
          throw new ContentModerationError("DECISION_NOT_ALLOWED");
        }
        const contentId = caseTarget.target_content_id;
        await this.#lockContentReportScope(transaction, contentId);

        const caseRows = await transaction<LockedCaseRow[]>`
          select
            moderation_case.id::text as case_id,
            moderation_case.version::text as version,
            moderation_case.target_type,
            moderation_case.target_content_id::text as target_content_id,
            moderation_case.status,
            moderation_case.assigned_admin_id::text as assigned_admin_id
          from platform.moderation_cases as moderation_case
          where moderation_case.id = ${caseId}
          for update
        `;
        const moderationCase = caseRows[0];
        if (!moderationCase) {
          throw new ContentModerationError("MODERATION_CASE_NOT_FOUND");
        }
        const currentCaseVersion = positiveInteger(
          moderationCase.version,
          "case_version",
        );
        if (
          moderationCase.target_type !== "content" ||
          moderationCase.target_content_id !== contentId
        ) {
          throw new ContentModerationError("CASE_VERSION_CONFLICT", {
            currentVersion: currentCaseVersion,
          });
        }
        if (currentCaseVersion !== decision.expectedCaseVersion) {
          throw new ContentModerationError("CASE_VERSION_CONFLICT", {
            currentVersion: currentCaseVersion,
          });
        }
        const restoring = decision.action === "restore_content";
        if (
          (restoring && moderationCase.status !== "resolved_action") ||
          (!restoring &&
            moderationCase.status !== "open" &&
            moderationCase.status !== "reviewing")
        ) {
          throw new ContentModerationError("CASE_NOT_ACTIONABLE", {
            currentVersion: currentCaseVersion,
          });
        }
        if (
          !restoring &&
          moderationCase.assigned_admin_id !== null &&
          moderationCase.assigned_admin_id !== admin.adminId
        ) {
          throw new ContentModerationError("CASE_ASSIGNMENT_CONFLICT", {
            currentVersion: currentCaseVersion,
          });
        }

        const contentRows = await transaction<LockedContentRow[]>`
          select
            content.version::text as version,
            content.kind,
            content.root_id::text as root_id,
            content.current_revision_id::text as current_revision_id,
            content.lifecycle_state,
            content.distribution_state
          from platform.content_items as content
          where content.id = ${contentId}
          for update
        `;
        const content = contentRows[0];
        if (!content) throw new ContentModerationError("CONTENT_NOT_FOUND");
        const contentVersionBefore = positiveInteger(content.version, "content_version");
        if (
          !isDistribution(content.distribution_state) ||
          (content.lifecycle_state !== "published" &&
            content.lifecycle_state !== "deleted") ||
          (content.kind !== "post" && content.kind !== "reply") ||
          !isUuid(content.root_id) ||
          !isUuid(content.current_revision_id)
        ) {
          throw new Error("The locked Content target contains invalid state.");
        }

        const transition = await this.#resolveDistributionTransition(
          transaction,
          caseId,
          contentId,
          currentCaseVersion,
          decision.action,
          content,
        );
        const actionId = this.#newId("moderation_action_id");
        const actionLogId = this.#newId("action_log_id");
        const finalCaseStatus = caseStatusForAction(decision.action);
        const finalResolutionCode = resolutionCode(decision.action, decision.reasonCode);

        let finalContentVersion = contentVersionBefore;
        if (decision.action !== "dismiss") {
          finalContentVersion = contentVersionBefore + 1;
          const updatedContent = await transaction<LockedContentRow[]>`
            update platform.content_items as content
            set version = content.version + 1,
                distribution_state = ${transition.after}
            where content.id = ${contentId}
              and content.version = ${contentVersionBefore}
              and content.lifecycle_state = 'published'
              and content.distribution_state = ${transition.before}
            returning
              content.version::text as version,
              content.kind,
              content.root_id::text as root_id,
              content.current_revision_id::text as current_revision_id,
              content.lifecycle_state,
              content.distribution_state
          `;
          const updated = updatedContent[0];
          if (
            !updated ||
            positiveInteger(updated.version, "content_version") !== finalContentVersion ||
            updated.distribution_state !== transition.after
          ) {
            throw new ContentModerationError("CONTENT_STATE_CONFLICT");
          }
        }

        if (!restoring) {
          const updatedReports = await transaction<{ count: string }[]>`
            with changed as (
              update platform.reports as report
              set version = report.version + 1,
                  status = ${finalCaseStatus}
              from platform.moderation_case_items as item
              where item.case_id = ${caseId}
                and item.report_id = report.id
                and report.status in ('open', 'reviewing')
              returning report.id
            )
            select count(*)::text as count from changed
          `;
          if (
            nonnegativeInteger(updatedReports[0]?.count ?? "0", "updated_report_count") <
            1
          ) {
            throw new ContentModerationError("CASE_NOT_ACTIONABLE");
          }
        }

        const updatedCases = restoring
          ? await transaction<{ closed_at: Date; updated_at: Date; version: string }[]>`
              update platform.moderation_cases as moderation_case
              set version = moderation_case.version + 1,
                  status = 'resolved_action',
                  assigned_admin_id = ${admin.adminId},
                  resolution_code = ${finalResolutionCode}
              where moderation_case.id = ${caseId}
                and moderation_case.version = ${currentCaseVersion}
                and moderation_case.status = 'resolved_action'
              returning
                moderation_case.version::text as version,
                moderation_case.updated_at,
                moderation_case.closed_at
            `
          : await transaction<{ closed_at: Date; updated_at: Date; version: string }[]>`
              update platform.moderation_cases as moderation_case
              set version = moderation_case.version + 1,
                  status = ${finalCaseStatus},
                  assigned_admin_id = ${admin.adminId},
                  resolution_code = ${finalResolutionCode}
              where moderation_case.id = ${caseId}
                and moderation_case.version = ${currentCaseVersion}
                and moderation_case.status in ('open', 'reviewing')
                and (
                  moderation_case.assigned_admin_id is null
                  or moderation_case.assigned_admin_id = ${admin.adminId}
                )
              returning
                moderation_case.version::text as version,
                moderation_case.updated_at,
                moderation_case.closed_at
            `;
        if (
          updatedCases.length !== 1 ||
          positiveInteger(updatedCases[0]?.version ?? "0", "case_version") !==
            currentCaseVersion + 1
        ) {
          throw new ContentModerationError("CASE_VERSION_CONFLICT", {
            currentVersion: currentCaseVersion,
          });
        }
        const updatedCase = updatedCases[0];
        if (!updatedCase?.closed_at || !updatedCase.updated_at) {
          throw new Error("Resolved moderation Case has no immutable timestamps.");
        }
        const decisionOccurredAt = copyDate(updatedCase.updated_at, "case_updated_at");
        const responseContentLifecycleState =
          decision.action === "dismiss" ? content.lifecycle_state : "published";
        const responseContentDistributionState =
          decision.action === "dismiss" ? content.distribution_state : transition.after;
        if (
          (responseContentLifecycleState !== "published" &&
            responseContentLifecycleState !== "deleted") ||
          responseContentDistributionState === null ||
          !isDistribution(responseContentDistributionState)
        ) {
          throw new Error("Moderation decision has no valid response Content state.");
        }

        const event = await appendOutboxEvent(transaction, {
          aggregateId: decision.action === "dismiss" ? caseId : contentId,
          aggregateType: decision.action === "dismiss" ? "moderation_case" : "content",
          eventType:
            decision.action === "dismiss"
              ? "moderation.case_dismissed"
              : "content.moderation_changed",
          eventVersion: 1,
          occurredAt: decisionOccurredAt,
          payload:
            decision.action === "dismiss"
              ? {
                  action_id: actionId,
                  case_id: caseId,
                  content_id: contentId,
                  reason_code: decision.reasonCode,
                  resolution_code: finalResolutionCode,
                  target_type: "content",
                }
              : {
                  after_distribution_state: transition.after,
                  before_distribution_state: transition.before,
                  case_id: caseId,
                  content_id: contentId,
                  current_revision_id: content.current_revision_id,
                  kind: content.kind,
                  moderation_action_id: actionId,
                  reason_code: decision.reasonCode,
                  resource_version: finalContentVersion,
                  root_content_id: content.root_id,
                },
        });

        const beforeState =
          decision.action === "dismiss"
            ? { case_id: caseId }
            : {
                distribution_state: transition.before,
                resource_version: contentVersionBefore,
              };
        const afterState =
          decision.action === "dismiss"
            ? {
                case_id: caseId,
                case_status: finalCaseStatus,
                moderation_action_id: actionId,
                resolution_code: finalResolutionCode,
              }
            : {
                case_id: caseId,
                content_id: contentId,
                distribution_state: transition.after,
                moderation_action_id: actionId,
                resource_version: finalContentVersion,
              };
        await transaction`
          insert into platform.action_logs (
            id,
            event_class,
            occurred_at,
            actor_id,
            actor_kind,
            owner_id,
            agent_id,
            credential_id,
            admin_id,
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
            retry_count,
            outbox_event_id,
            policy_version,
            request_id,
            security_subject_digest,
            before_state,
            after_state,
            reason_code
          )
          values (
            ${actionLogId},
            'governance',
            ${decisionOccurredAt},
            null,
            null,
            null,
            null,
            null,
            ${admin.adminId},
            'admin_web',
            'admin_override',
            null,
            'workforce_oidc',
            ${transaction.json({
              permission: "moderation:decide",
              permissions: effective.permissions,
              roles: effective.roles,
            })},
            ${actionAuditName(decision.action)},
            'content',
            ${contentId},
            'allow',
            'succeeded',
            null,
            0,
            ${event.id},
            null,
            ${admin.requestId},
            null,
            ${transaction.json(beforeState)},
            ${transaction.json(afterState)},
            ${decision.reasonCode}
          )
        `;

        const insertedActions = await transaction<ActionRow[]>`
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
            ${caseId},
            ${admin.adminId},
            'moderation:decide',
            ${decision.action},
            ${decision.reasonCode},
            ${decision.internalNote},
            ${transition.before},
            ${transition.after},
            ${decision.action === "dismiss" ? null : contentVersionBefore},
            ${decision.action === "dismiss" ? null : finalContentVersion},
            ${currentCaseVersion},
            ${currentCaseVersion + 1},
            (
              select moderation_case.updated_at
              from platform.moderation_cases as moderation_case
              where moderation_case.id = ${caseId}
            ),
            (
              select moderation_case.closed_at
              from platform.moderation_cases as moderation_case
              where moderation_case.id = ${caseId}
            ),
            ${finalContentVersion},
            ${responseContentLifecycleState},
            ${responseContentDistributionState},
            ${transition.revertedActionId},
            ${decision.idempotencyKey},
            ${digest},
            ${actionLogId},
            ${event.id}
          )
          returning
            id::text as id,
            case_id::text as case_id,
            admin_id::text as admin_id,
            action,
            reason_code,
            internal_note,
            before_distribution_state,
            after_distribution_state,
            target_version_before::text as target_version_before,
            target_version_after::text as target_version_after,
            case_version_before::text as case_version_before,
            case_version_after::text as case_version_after,
            case_updated_at_after,
            case_closed_at_after,
            response_content_version::text as response_content_version,
            response_content_lifecycle_state,
            response_content_distribution_state,
            reverts_action_id::text as reverts_action_id,
            occurred_at,
            ${contentId}::text as content_id
        `;
        const insertedAction = insertedActions[0];
        if (!insertedAction)
          throw new Error("Moderation action insertion returned no row.");
        return this.#decisionOutcome(transaction, insertedAction, caseId, false);
      });
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  async listContentActions(
    ownerIdValue: string,
    contentIdValue: string,
    input: ListOwnerContentModerationInput,
  ): Promise<OwnerContentModerationHistoryView> {
    const ownerId = normalizeUuid(ownerIdValue, "owner_id");
    const contentId = normalizeUuid(contentIdValue, "content_id");
    const limit = validateLimit(input.limit);
    const purpose = "alphanet.owner.content-moderation-actions.v1";
    const filters = { content_id: contentId, limit, owner_id: ownerId };
    const cursor =
      input.cursor === undefined || input.cursor === null
        ? null
        : decodeCursorEnvelope(
            input.cursor,
            this.#cursorSigningKey,
            purpose,
            filters,
            isDescendingPosition,
          );
    const asOf = cursor ? new Date(cursor.asOf) : validClockDate(this.#clock);
    const snapshotId = cursor?.snapshotId ?? this.#newId("snapshot_id");

    try {
      return await this.#sql.begin(
        "isolation level repeatable read",
        async (transaction) => {
          await transaction`set local statement_timeout = '10s'`;
          const contentRows = await transaction<OwnerContentRow[]>`
          select
            content.id::text as content_id,
            content.version::text as version,
            content.distribution_state
          from platform.owners as owner
          join platform.actors as author
            on author.owner_id = owner.id
          join platform.content_items as content
            on content.author_actor_id = author.id
          where owner.id = ${ownerId}
            and owner.status = 'active'
            and owner.email_verified_at is not null
            and owner.deleted_at is null
            and content.id = ${contentId}
        `;
          const content = contentRows[0];
          if (!content || !isDistribution(content.distribution_state)) {
            throw new ContentModerationError("OWNER_CONTENT_NOT_FOUND");
          }
          const rows = await this.#listContentActions(
            transaction,
            contentId,
            asOf,
            cursor?.position ?? null,
            limit + 1,
          );
          return {
            contentId,
            contentVersion: positiveInteger(content.version, "content_version"),
            distributionState: content.distribution_state,
            page: this.#descendingPage(
              rows,
              limit,
              asOf,
              snapshotId,
              purpose,
              filters,
              ownerAction,
              "owner-content-moderation-list-v1",
            ),
          };
        },
      );
    } catch (error) {
      throw this.#asUnavailable(error);
    }
  }

  #newId(field: string): string {
    const value = this.#idFactory().toLowerCase();
    if (!isUuid(value)) throw new Error(`${field} factory returned an invalid UUID.`);
    return value;
  }

  #asUnavailable(error: unknown): ContentModerationError {
    if (error instanceof ContentModerationError) return error;
    return new ContentModerationError("MODERATION_UNAVAILABLE", { cause: error });
  }

  async #revalidateAdmin(
    transaction: TransactionSql,
    context: ValidatedAdminContext,
    requiredPermission: "moderation:read" | "moderation:decide",
  ): Promise<EffectiveAdminAuthorization> {
    const rows = await transaction<AdminRbacRow[]>`
      select
        admin.id::text as admin_id,
        role.key as role_key,
        role_permission.permission
      from platform.admins as admin
      join platform.admin_assignments as assignment
        on assignment.admin_id = admin.id
       and assignment.granted_at <= clock_timestamp()
       and assignment.revoked_at is null
       and (
         assignment.expires_at is null
         or assignment.expires_at > clock_timestamp()
       )
      join platform.admin_roles as role
        on role.id = assignment.role_id
       and role.status = 'active'
      join platform.admin_role_permissions as role_permission
        on role_permission.role_id = role.id
      where admin.id = ${context.adminId}
        and admin.status = 'active'
    `;
    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.admin_id !== context.adminId ||
          !ROLE_PATTERN.test(row.role_key) ||
          !permissionSet.has(row.permission),
      )
    ) {
      throw new ContentModerationError("ADMIN_PERMISSION_REQUIRED");
    }
    const permissions = sortedUnique(
      rows.map((row) => row.permission as AdminPermission),
    );
    const roles = sortedUnique(rows.map((row) => row.role_key));
    if (!permissions.includes(requiredPermission)) {
      throw new ContentModerationError("ADMIN_PERMISSION_REQUIRED");
    }
    return { permissions, roles };
  }

  async #lockIdempotencyScope(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:moderation-decision:'
            || pg_catalog.octet_length(${adminId}::text)::text
            || ':'
            || ${adminId}::text
            || ':'
            || ${idempotencyKey}::text,
          0
        )
      )
    `;
  }

  async #lockContentReportScope(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'alphanet:content-report:' || ${contentId}::text,
          0
        )
      )
    `;
  }

  async #findDecisionReplay(
    transaction: TransactionSql,
    adminId: string,
    idempotencyKey: string,
  ): Promise<{ action: ActionRow; caseId: string } | null> {
    const rows = await transaction<ActionRow[]>`
      select
        action.id::text as id,
        action.case_id::text as case_id,
        moderation_case.target_content_id::text as content_id,
        action.admin_id::text as admin_id,
        action.action,
        action.reason_code,
        action.internal_note,
        action.before_distribution_state,
        action.after_distribution_state,
        action.target_version_before::text as target_version_before,
        action.target_version_after::text as target_version_after,
        action.case_version_before::text as case_version_before,
        action.case_version_after::text as case_version_after,
        action.case_updated_at_after,
        action.case_closed_at_after,
        action.response_content_version::text as response_content_version,
        action.response_content_lifecycle_state,
        action.response_content_distribution_state,
        action.reverts_action_id::text as reverts_action_id,
        action.request_digest,
        action.occurred_at
      from platform.moderation_actions as action
      join platform.moderation_cases as moderation_case
        on moderation_case.id = action.case_id
      where action.admin_id = ${adminId}
        and action.idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) return null;
    if (rows.length !== 1 || !row.request_digest) {
      throw new Error("Moderation idempotency lookup returned invalid state.");
    }
    return { action: row, caseId: row.case_id };
  }

  async #resolveDistributionTransition(
    transaction: TransactionSql,
    caseId: string,
    contentId: string,
    currentCaseVersion: number,
    action: ContentModerationAction,
    content: LockedContentRow,
  ): Promise<{
    after: ModeratedContentDistribution | null;
    before: ModeratedContentDistribution | null;
    revertedActionId: string | null;
  }> {
    if (action === "dismiss") {
      return { after: null, before: null, revertedActionId: null };
    }
    if (content.lifecycle_state !== "published") {
      throw new ContentModerationError("CONTENT_STATE_CONFLICT");
    }
    if (!isDistribution(content.distribution_state)) {
      throw new Error("Content has an invalid distribution state.");
    }
    const before = content.distribution_state;
    if (action === "limit_content") {
      if (before !== "normal" && before !== "hidden") {
        throw new ContentModerationError("CONTENT_STATE_CONFLICT");
      }
      return { after: "limited", before, revertedActionId: null };
    }
    if (action === "hide_content") {
      if (before !== "normal" && before !== "limited") {
        throw new ContentModerationError("CONTENT_STATE_CONFLICT");
      }
      return { after: "hidden", before, revertedActionId: null };
    }
    if (before !== "limited" && before !== "hidden") {
      throw new ContentModerationError("CONTENT_STATE_CONFLICT");
    }
    const candidates = await transaction<RestoreCandidateRow[]>`
      select prior.id::text as id
      from platform.moderation_actions as prior
      where prior.case_id = ${caseId}
        and prior.action in ('limit_content', 'hide_content')
        and prior.case_version_after = ${currentCaseVersion}
        and prior.after_distribution_state = ${before}
        and prior.target_version_after <= ${positiveInteger(content.version, "content_version")}
        and not exists (
          select 1
          from platform.moderation_actions as reverter
          where reverter.reverts_action_id = prior.id
            and reverter.action = 'restore_content'
        )
        and not exists (
          select 1
          from platform.moderation_actions as later_action
          join platform.moderation_cases as later_case
            on later_case.id = later_action.case_id
          where later_case.target_type = 'content'
            and later_case.target_content_id = ${contentId}
            and later_action.action in (
              'limit_content',
              'hide_content',
              'restore_content'
            )
            and later_action.target_version_after > prior.target_version_after
        )
      order by prior.target_version_after desc, prior.id desc
      limit 1
    `;
    const prior = candidates[0];
    if (!prior || !isUuid(prior.id)) {
      throw new ContentModerationError("CONTENT_STATE_CONFLICT");
    }
    return { after: "normal", before, revertedActionId: prior.id };
  }

  async #decisionOutcome(
    transaction: TransactionSql,
    actionRow: ActionRow,
    caseId: string,
    replayed: boolean,
  ): Promise<ModerationDecisionOutcome> {
    const summaries = await this.#queryCaseSummaries(transaction, {
      asOf: null,
      filters: {
        contentId: null,
        limit: 1,
        priorities: ["normal", "high", "urgent"],
        reasons: [],
        statuses: ["open", "reviewing", "resolved_action", "dismissed"],
      },
      limit: 1,
      position: null,
      requestedCaseId: caseId,
    });
    const summaryRow = summaries[0];
    if (!summaryRow) throw new Error("Resolved moderation Case could not be reloaded.");
    const action = mapAction(actionRow);
    const caseVersionBefore = positiveInteger(
      actionRow.case_version_before,
      "case_version_before",
    );
    const caseVersionAfter = positiveInteger(
      actionRow.case_version_after,
      "case_version_after",
    );
    const responseContentVersion = positiveInteger(
      actionRow.response_content_version,
      "response_content_version",
    );
    if (
      caseVersionAfter !== caseVersionBefore + 1 ||
      (actionRow.response_content_lifecycle_state !== "published" &&
        actionRow.response_content_lifecycle_state !== "deleted") ||
      !isDistribution(actionRow.response_content_distribution_state)
    ) {
      throw new Error("Stored moderation action has an invalid response snapshot.");
    }
    // Project the immutable post-decision snapshot owned by the Action. This is
    // required for permanent idempotency replay after a later restore or author
    // deletion changes the live Case/Content projection.
    const summary: ModerationCaseSummaryView = {
      ...mapCaseSummary(summaryRow),
      contentVersion: responseContentVersion,
      distributionState: actionRow.response_content_distribution_state,
      latestActionId: action.moderationActionId,
      lifecycleState: actionRow.response_content_lifecycle_state,
      resolutionAction: action.action,
      resolvedAt: copyDate(actionRow.case_closed_at_after, "case_closed_at_after"),
      status: action.action === "dismiss" ? "dismissed" : "resolved_action",
      updatedAt: copyDate(actionRow.case_updated_at_after, "case_updated_at_after"),
      version: caseVersionAfter,
    };
    return {
      action,
      case: summary,
      caseVersionBefore,
      content: {
        contentId: summary.contentId,
        distributionState: summary.distributionState,
        lifecycleState: summary.lifecycleState,
        resourceVersion: summary.contentVersion,
      },
      replayed,
    };
  }

  async #queryCaseSummaries(
    transaction: TransactionSql,
    query: {
      asOf: Date | null;
      filters: NormalizedCaseFilters;
      limit: number;
      position: ListCursorPosition | null;
      requestedCaseId?: string | undefined;
    },
  ): Promise<CaseSummaryRow[]> {
    const position = query.position;
    const requestedCaseId = query.requestedCaseId ?? null;
    return transaction<CaseSummaryRow[]>`
      select
        moderation_case.id::text as case_id,
        moderation_case.version::text as case_version,
        content.id::text as content_id,
        content.version::text as content_version,
        content.kind as content_kind,
        content.lifecycle_state,
        content.distribution_state,
        author.id::text as actor_id,
        author.kind as actor_kind,
        author.handle::text as handle,
        agent.id::text as agent_id,
        moderation_case.status,
        moderation_case.priority,
        report_totals.report_count,
        report_totals.spam_count,
        report_totals.harassment_count,
        report_totals.impersonation_count,
        report_totals.malicious_link_count,
        report_totals.privacy_exposure_count,
        report_totals.other_rule_violation_count,
        moderation_case.opened_at,
        report_totals.last_reported_at,
        moderation_case.updated_at,
        moderation_case.closed_at,
        latest_action.id::text as latest_action_id,
        latest_action.action as latest_action
      from platform.moderation_cases as moderation_case
      join platform.content_items as content
        on moderation_case.target_type = 'content'
       and content.id = moderation_case.target_content_id
      join platform.actors as author on author.id = content.author_actor_id
      left join platform.agents as agent on agent.actor_id = author.id
      join lateral (
        select
          count(*)::text as report_count,
          count(*) filter (where report.reason_code = 'spam')::text as spam_count,
          count(*) filter (where report.reason_code = 'harassment')::text as harassment_count,
          count(*) filter (where report.reason_code = 'impersonation')::text as impersonation_count,
          count(*) filter (where report.reason_code = 'malicious_link')::text as malicious_link_count,
          count(*) filter (where report.reason_code = 'privacy_exposure')::text as privacy_exposure_count,
          count(*) filter (
            where report.reason_code = 'other_rule_violation'
          )::text as other_rule_violation_count,
          max(report.created_at) as last_reported_at
        from platform.moderation_case_items as item
        join platform.reports as report on report.id = item.report_id
        where item.case_id = moderation_case.id
      ) as report_totals on report_totals.report_count::bigint > 0
      left join lateral (
        select action.id, action.action
        from platform.moderation_actions as action
        where action.case_id = moderation_case.id
        order by action.case_version_after desc, action.id desc
        limit 1
      ) as latest_action on true
      where (${requestedCaseId}::uuid is null or moderation_case.id = ${requestedCaseId}::uuid)
        and (
          ${query.asOf}::timestamptz is null
          or moderation_case.opened_at <= ${query.asOf}
        )
        and moderation_case.status = any(${query.filters.statuses}::text[])
        and moderation_case.priority = any(${query.filters.priorities}::text[])
        and (${query.filters.contentId}::uuid is null or content.id = ${query.filters.contentId}::uuid)
        and (
          ${query.filters.reasons.length === 0}
          or exists (
            select 1
            from platform.moderation_case_items as reason_item
            join platform.reports as reason_report on reason_report.id = reason_item.report_id
            where reason_item.case_id = moderation_case.id
              and reason_report.reason_code = any(${query.filters.reasons}::text[])
          )
        )
        and (
          ${position === null}
          or case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end
              > ${position?.activeRank ?? 0}
          or (
            case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end
              = ${position?.activeRank ?? 0}
            and case moderation_case.priority
              when 'urgent' then 0 when 'high' then 1 else 2 end
              > ${position?.priorityRank ?? 0}
          )
          or (
            case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end
              = ${position?.activeRank ?? 0}
            and case moderation_case.priority
              when 'urgent' then 0 when 'high' then 1 else 2 end
              = ${position?.priorityRank ?? 0}
            and report_totals.last_reported_at < ${position ? new Date(position.lastReportedAt) : null}
          )
          or (
            case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end
              = ${position?.activeRank ?? 0}
            and case moderation_case.priority
              when 'urgent' then 0 when 'high' then 1 else 2 end
              = ${position?.priorityRank ?? 0}
            and report_totals.last_reported_at = ${position ? new Date(position.lastReportedAt) : null}
            and moderation_case.opened_at > ${position ? new Date(position.openedAt) : null}
          )
          or (
            case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end
              = ${position?.activeRank ?? 0}
            and case moderation_case.priority
              when 'urgent' then 0 when 'high' then 1 else 2 end
              = ${position?.priorityRank ?? 0}
            and report_totals.last_reported_at = ${position ? new Date(position.lastReportedAt) : null}
            and moderation_case.opened_at = ${position ? new Date(position.openedAt) : null}
            and moderation_case.id > ${position?.id ?? null}::uuid
          )
        )
      order by
        case when moderation_case.status in ('open', 'reviewing') then 0 else 1 end,
        case moderation_case.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
        report_totals.last_reported_at desc,
        moderation_case.opened_at,
        moderation_case.id
      limit ${query.limit}
    `;
  }

  #descendingPage<TRow extends { id: string }, TView>(
    rows: TRow[],
    limit: number,
    asOf: Date,
    snapshotId: string,
    purpose: string,
    filters: Record<string, unknown>,
    mapper: (row: TRow) => TView,
    orderingVersion: string,
  ): CursorPage<TView> {
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const last = visibleRows.at(-1);
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const raw = last as TRow & {
        created_at?: Date | undefined;
        occurred_at?: Date | undefined;
      };
      const occurredAt = raw.occurred_at ?? raw.created_at;
      if (!occurredAt) throw new Error("Cursor row has no ordering timestamp.");
      nextCursor = encodeCursor(
        {
          asOf: asOf.toISOString(),
          filters,
          position: {
            id: last.id,
            occurredAt: copyDate(occurredAt, "cursor_timestamp").toISOString(),
          },
          purpose,
          snapshotId,
          version: CURSOR_VERSION,
        },
        this.#cursorSigningKey,
      );
    }
    return {
      asOf,
      hasMore,
      items: visibleRows.map(mapper),
      limit,
      nextCursor,
      orderingVersion,
      snapshotId,
    };
  }

  async #loadContentSnapshot(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<ContentSnapshotRow[]> {
    return transaction<ContentSnapshotRow[]>`
      select
        content.id::text as content_id,
        content.version::text as version,
        content.kind,
        content.root_id::text as root_id,
        content.parent_id::text as parent_id,
        content.depth,
        content.current_revision_id::text as current_revision_id,
        content.lifecycle_state,
        content.distribution_state,
        content.created_at,
        content.updated_at,
        content.deleted_at,
        revision.title,
        revision.body_markdown,
        author.id::text as actor_id,
        author.kind as actor_kind,
        author.handle::text as handle,
        agent.id::text as agent_id
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
       and revision.content_id = content.id
      join platform.actors as author on author.id = content.author_actor_id
      left join platform.agents as agent on agent.actor_id = author.id
      where content.id = ${contentId}
    `;
  }

  async #listReports(
    transaction: TransactionSql,
    caseId: string,
    asOf: Date,
    position: DescendingCursorPosition | null,
    limit: number,
  ): Promise<ReportRow[]> {
    return transaction<ReportRow[]>`
      select
        report.id::text as id,
        report.version::text as version,
        item.case_id::text as case_id,
        report.target_content_id::text as content_id,
        report.reporter_owner_id::text as reporter_owner_id,
        report.reporter_actor_id::text as reporter_actor_id,
        report.reason_code,
        report.description,
        report.status,
        report.created_at,
        report.updated_at,
        report.resolved_at
      from platform.moderation_case_items as item
      join platform.reports as report on report.id = item.report_id
      where item.case_id = ${caseId}
        and report.created_at <= ${asOf}
        and (
          ${position === null}
          or (report.created_at, report.id) < (
            ${position ? new Date(position.occurredAt) : null}::timestamptz,
            ${position?.id ?? null}::uuid
          )
        )
      order by report.created_at desc, report.id desc
      limit ${limit}
    `;
  }

  async #listActions(
    transaction: TransactionSql,
    caseId: string,
    asOf: Date,
    position: DescendingCursorPosition | null,
    limit: number,
  ): Promise<ActionRow[]> {
    return transaction<ActionRow[]>`
      select
        action.id::text as id,
        action.case_id::text as case_id,
        moderation_case.target_content_id::text as content_id,
        action.admin_id::text as admin_id,
        action.action,
        action.reason_code,
        action.internal_note,
        action.before_distribution_state,
        action.after_distribution_state,
        action.target_version_before::text as target_version_before,
        action.target_version_after::text as target_version_after,
        action.case_version_before::text as case_version_before,
        action.case_version_after::text as case_version_after,
        action.case_updated_at_after,
        action.case_closed_at_after,
        action.response_content_version::text as response_content_version,
        action.response_content_lifecycle_state,
        action.response_content_distribution_state,
        action.reverts_action_id::text as reverts_action_id,
        action.occurred_at
      from platform.moderation_actions as action
      join platform.moderation_cases as moderation_case
        on moderation_case.id = action.case_id
      where action.case_id = ${caseId}
        and action.occurred_at <= ${asOf}
        and (
          ${position === null}
          or (action.occurred_at, action.id) < (
            ${position ? new Date(position.occurredAt) : null}::timestamptz,
            ${position?.id ?? null}::uuid
          )
        )
      order by action.occurred_at desc, action.id desc
      limit ${limit}
    `;
  }

  async #listContentActions(
    transaction: TransactionSql,
    contentId: string,
    asOf: Date,
    position: DescendingCursorPosition | null,
    limit: number,
  ): Promise<ActionRow[]> {
    return transaction<ActionRow[]>`
      select
        action.id::text as id,
        action.case_id::text as case_id,
        moderation_case.target_content_id::text as content_id,
        action.admin_id::text as admin_id,
        action.action,
        action.reason_code,
        action.internal_note,
        action.before_distribution_state,
        action.after_distribution_state,
        action.target_version_before::text as target_version_before,
        action.target_version_after::text as target_version_after,
        action.case_version_before::text as case_version_before,
        action.case_version_after::text as case_version_after,
        action.case_updated_at_after,
        action.case_closed_at_after,
        action.response_content_version::text as response_content_version,
        action.response_content_lifecycle_state,
        action.response_content_distribution_state,
        action.reverts_action_id::text as reverts_action_id,
        action.occurred_at
      from platform.moderation_actions as action
      join platform.moderation_cases as moderation_case
        on moderation_case.id = action.case_id
      where moderation_case.target_type = 'content'
        and moderation_case.target_content_id = ${contentId}
        and action.occurred_at <= ${asOf}
        and (
          ${position === null}
          or (action.occurred_at, action.id) < (
            ${position ? new Date(position.occurredAt) : null}::timestamptz,
            ${position?.id ?? null}::uuid
          )
        )
      order by action.occurred_at desc, action.id desc
      limit ${limit}
    `;
  }

  async #writeSensitiveReadAudit(
    transaction: TransactionSql,
    event: {
      admin: ValidatedAdminContext;
      authorization: EffectiveAdminAuthorization;
      caseId: string;
      now: Date;
    },
  ): Promise<void> {
    await transaction`
      insert into platform.action_logs (
        id,
        event_class,
        occurred_at,
        actor_id,
        actor_kind,
        owner_id,
        agent_id,
        credential_id,
        admin_id,
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
        retry_count,
        outbox_event_id,
        policy_version,
        request_id,
        security_subject_digest,
        before_state,
        after_state,
        reason_code
      )
      values (
        ${this.#newId("sensitive_read_audit_id")},
        'sensitive_read',
        ${event.now},
        null,
        null,
        null,
        null,
        null,
        ${event.admin.adminId},
        'admin_web',
        'admin_override',
        null,
        'workforce_oidc',
        ${transaction.json({
          permission: "moderation:read",
          permissions: event.authorization.permissions,
          roles: event.authorization.roles,
        })},
        'moderation.case_sensitive_read',
        'moderation_case',
        ${event.caseId},
        'allow',
        'succeeded',
        null,
        0,
        null,
        null,
        ${event.admin.requestId},
        null,
        null,
        null,
        'case_review'
      )
    `;
  }
}
