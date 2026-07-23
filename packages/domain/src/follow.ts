import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { evaluateAgentOperation, type AgentOperationEvaluation } from "./agent-policy.js";
import { readCommunityWriteControl } from "./admin-platform-operations.js";
import type {
  AgentCredentialContext,
  AgentPolicyTier,
  AgentScope,
} from "./agent-connection.js";
import type { OwnerWebMutationContext } from "./owner-web-session-context.js";
import {
  AGENT_POLICY_CONTROL_MIGRATION_CHECKSUM,
  FOLLOW_GRAPH_MIGRATION_CHECKSUM,
  PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM,
} from "./schema-migrations.js";
import {
  evaluateOwnerDirectOperation,
  type WebSocialAuthority,
  type WebSocialAuthorityResolver,
  type WebSocialAuthoritySelection,
} from "./web-social-authority.js";

const FOLLOW_GRAPH_MIGRATION_NAME = "follow_graph";
const FOLLOW_GRAPH_MIGRATION_VERSION = "000011";

const IDEMPOTENCY_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const NEW_AGENT_FOLLOWS_PER_HOUR = 30;
const ESTABLISHED_AGENT_FOLLOWS_PER_HOUR = 60;
const NEW_AGENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const FOLLOW_RATE_WINDOW_MS = 60 * 60 * 1_000;
const FOLLOW_RATE_RULE_VERSION = "follow-rate-v1";
const FOLLOW_CARDINALITY_LIMIT = 1_000;
const FOLLOW_CARDINALITY_RULE_VERSION = "follow-cardinality-v1";
const DEFAULT_LIST_LIMIT = 20;
const MAXIMUM_LIST_LIMIT = 100;
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
const DEFAULT_QUERY_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_CURSOR_LENGTH = 4_096;
const CURSOR_VERSION = 1;
const CURSOR_SIGNATURE_DOMAIN = "alphanet.follow-list.cursor-signature.v1";
const CURSOR_BINDING_DOMAIN = "alphanet.follow-list.cursor-binding.v1";
const SNAPSHOT_ID_DOMAIN = "alphanet.follow-list.snapshot-id.v1";
export const FOLLOW_LIST_ORDERING_VERSION = "follow-list-v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,14}$/u;
const TOPIC_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FOLLOW_TARGET_TYPES = ["actor", "symbol", "topic", "content"] as const;
const FOLLOW_NOTIFICATION_LEVELS = ["feed_only", "new_posts", "all_events"] as const;
const FOLLOW_ERROR_CODES = [
  "AUTHORIZATION_CONTEXT_STALE",
  "CURSOR_EXPIRED",
  "CURSOR_INVALID",
  "FOLLOW_DATA_INVALID",
  "FOLLOW_LIMIT_REACHED",
  "FOLLOW_NOT_READY",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_RESULT_CORRUPT",
  "INVALID_ARGUMENT",
  "PLATFORM_WRITE_PAUSED",
  "POLICY_DENIED",
  "RATE_LIMITED",
  "SCOPE_REQUIRED",
  "SELF_FOLLOW_NOT_ALLOWED",
  "SNAPSHOT_EXPIRED",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_FOUND",
  "TARGET_NOT_VISIBLE",
  "VALIDATION_ERROR",
] as const;

type TransactionSql = postgres.TransactionSql;
type QuerySql = postgres.Sql | postgres.TransactionSql;

export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number];
export type FollowNotificationLevel = (typeof FOLLOW_NOTIFICATION_LEVELS)[number];
export type FollowWriteDecision = "allow" | "deny";
export type FollowWriteStatus = "succeeded" | "denied" | "failed";
export type FollowErrorCode = (typeof FOLLOW_ERROR_CODES)[number];

export interface FollowTarget {
  targetId: string;
  targetType: FollowTargetType;
}

export interface SetFollowInput extends FollowTarget {
  active: boolean;
  idempotencyKey: string;
  notificationLevel?: FollowNotificationLevel | undefined;
}

export interface NormalizedSetFollowCommand extends FollowTarget {
  active: boolean;
  idempotencyKey: string;
  notificationLevel: FollowNotificationLevel | null;
  notificationLevelProvided: boolean;
}

export interface FollowRequestContext {
  channel?: string | undefined;
  requestId: string;
}

export interface SetFollowResult extends FollowTarget {
  active: boolean;
  notificationLevel: FollowNotificationLevel | null;
  updatedAt: Date;
}

export interface FollowErrorDetail {
  code: FollowErrorCode;
  details: Record<string, string | number | boolean | null> | null;
  message: string;
  retryAfterMs: number | null;
  retryable: boolean;
}

export interface FollowWriteOutcome {
  decision: FollowWriteDecision;
  error: FollowErrorDetail | null;
  operation: "set_follow";
  pendingAction: null;
  replayed: boolean;
  result: SetFollowResult | null;
  status: FollowWriteStatus;
}

export interface FollowProjection extends FollowTarget {
  createdAt: Date;
  followId: string;
  notificationLevel: FollowNotificationLevel;
  updatedAt: Date;
}

export interface FollowListInput {
  cursor?: string | null | undefined;
  limit?: number | undefined;
  targetType?: FollowTargetType | undefined;
}

export interface NormalizedFollowListInput {
  cursor: string | null;
  limit: number;
  targetType: FollowTargetType | null;
}

export interface FollowListPage {
  items: FollowProjection[];
  ordering: {
    asOf: Date;
    orderingVersion: typeof FOLLOW_LIST_ORDERING_VERSION;
    snapshotId: string;
  };
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
}

export interface FollowService {
  checkReady(): Promise<void>;
  listFollows(
    context: AgentCredentialContext,
    input: FollowListInput,
  ): Promise<FollowListPage>;
  setFollow(
    context: AgentCredentialContext,
    input: SetFollowInput,
    request: FollowRequestContext,
  ): Promise<FollowWriteOutcome>;
}

export interface OwnerWebFollowService {
  setFollowAsOwnerWeb(
    context: OwnerWebMutationContext,
    selection: WebSocialAuthoritySelection,
    input: SetFollowInput,
  ): Promise<FollowWriteOutcome>;
}

export interface PostgresFollowServiceOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Buffer;
  cursorTtlSeconds?: number | undefined;
  defaultListLimit?: number | undefined;
  idFactory?: (() => string) | undefined;
  idempotencyRetentionMs?: number | undefined;
  queryTimeoutMilliseconds?: number | undefined;
  webSocialAuthorityResolver?: WebSocialAuthorityResolver | undefined;
}

export class FollowError extends Error {
  readonly code: FollowErrorCode;
  readonly details: Record<string, string | number | boolean | null> | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: FollowErrorCode,
    message: string,
    options: {
      details?: Record<string, string | number | boolean | null> | null | undefined;
      retryAfterMs?: number | null | undefined;
      retryable?: boolean | undefined;
      statusCode?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "FollowError";
    this.code = code;
    this.details = options.details ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? statusForError(code);
  }

  toDetail(): FollowErrorDetail {
    return {
      code: this.code,
      details: this.details,
      message: this.message,
      retryAfterMs: this.retryAfterMs,
      retryable: this.retryable,
    };
  }
}

interface AuthorizationRow {
  actor_id: string;
  agent_activated_at: Date;
  credential_policy_ceiling: AgentPolicyTier;
  credential_policy_ceiling_defaults_version: string;
  credential_policy_ceiling_rules: unknown;
  credential_policy_ceiling_schema_version: number;
  credential_scopes: AgentScope[];
  defaults_version: string;
  policy_id: string;
  policy_rules: unknown;
  policy_schema_version: number;
  policy_tier: AgentPolicyTier;
  policy_version: string;
}

interface IdempotencyRow {
  request_digest: Buffer;
  resource_id: string | null;
  response_body: unknown;
  response_code: number | null;
  status:
    | "admission_reserved"
    | "in_progress"
    | "pending_approval"
    | "succeeded"
    | "denied"
    | "failed";
}

interface ResolvedTarget extends FollowTarget {
  resourceId: string;
}

interface ActorTargetRow {
  deleted_at: Date | null;
  id: string;
  status: string;
}

interface SymbolTargetRow {
  followed: boolean;
  id: string;
  status: string;
  ticker: string;
}

interface TopicTargetRow {
  deleted_at: Date | null;
  id: string;
  slug: string;
}

interface ContentTargetRow {
  community_deleted_at: Date | null;
  community_status: string;
  content_distribution_state: string;
  content_lifecycle_state: string;
  id: string;
  root_distribution_state: string;
  root_lifecycle_state: string;
}

interface FollowRow {
  created_at: Date;
  id: string;
  notification_level: string;
  updated_at: Date;
}

interface FollowRateRow {
  follow_count: number;
  retry_at: Date | null;
}

interface FollowCardinalityRow {
  follow_count: number;
}

interface FollowWritePrincipal {
  actorId: string;
  actorKind: "agent" | "human";
  activatedAt: Date;
  agentId: string | null;
  approvalMethod: "human_direct" | "owner_direct" | "policy_auto";
  authenticationAssurance: "agent_credential" | "fresh_owner_session" | "owner_session";
  authorizationSnapshot(decisionId: string): postgres.JSONValue;
  credentialId: string | null;
  evaluation: AgentOperationEvaluation;
  ownerId: string;
  policyVersion: string | null;
  principalScopeKey: string;
}

interface FollowListRow extends FollowRow {
  target_id: string;
  target_type: string;
}

interface EpochRow {
  epoch: string;
}

interface DatabaseTimeRow {
  as_of: Date;
}

interface PersistedFollowOutcome {
  decision: FollowWriteDecision;
  error: null | {
    code: FollowErrorCode;
    details: Record<string, string | number | boolean | null> | null;
    message: string;
    retry_after_ms: number | null;
    retryable: boolean;
  };
  operation: "set_follow";
  pending_action: null;
  resource_id: string | null;
  result: null | {
    active: boolean;
    notification_level: FollowNotificationLevel | null;
    target_id: string;
    target_type: FollowTargetType;
    updated_at: string;
  };
  status: FollowWriteStatus;
  version: 1;
}

interface FollowCursorPayload {
  asOf: string;
  binding: string;
  epoch: string;
  expiresAt: string;
  kind: "follow-list";
  last: {
    id: string;
    updatedAt: string;
  };
  snapshotId: string;
  v: 1;
}

interface ParsedFollowCursor {
  asOf: Date;
  epoch: string;
  expiresAt: Date;
  lastId: string;
  lastUpdatedAt: Date;
  snapshotId: string;
}

function statusForError(code: FollowErrorCode): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "POLICY_DENIED":
    case "SCOPE_REQUIRED":
    case "TARGET_NOT_VISIBLE":
      return 403;
    case "TARGET_NOT_FOUND":
      return 404;
    case "CURSOR_EXPIRED":
    case "SNAPSHOT_EXPIRED":
      return 410;
    case "FOLLOW_LIMIT_REACHED":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "SELF_FOLLOW_NOT_ALLOWED":
    case "TARGET_AMBIGUOUS":
      return 409;
    case "CURSOR_INVALID":
    case "INVALID_ARGUMENT":
      return 400;
    case "RATE_LIMITED":
      return 429;
    case "PLATFORM_WRITE_PAUSED":
      return 503;
    case "VALIDATION_ERROR":
      return 422;
    case "FOLLOW_DATA_INVALID":
    case "FOLLOW_NOT_READY":
    case "IDEMPOTENCY_RESULT_CORRUPT":
      return 503;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isFollowTargetType(value: unknown): value is FollowTargetType {
  return (
    typeof value === "string" && FOLLOW_TARGET_TYPES.includes(value as FollowTargetType)
  );
}

function isNotificationLevel(value: unknown): value is FollowNotificationLevel {
  return (
    typeof value === "string" &&
    FOLLOW_NOTIFICATION_LEVELS.includes(value as FollowNotificationLevel)
  );
}

function isFollowErrorCode(value: unknown): value is FollowErrorCode {
  return (
    typeof value === "string" && FOLLOW_ERROR_CODES.includes(value as FollowErrorCode)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function asDate(value: unknown, code: FollowErrorCode): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) {
    throw new FollowError(code, "Stored Follow time data is invalid.", {
      retryable: code === "FOLLOW_DATA_INVALID",
    });
  }
  return date;
}

function canonicalUuid(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!isUuid(normalized)) {
    throw new FollowError(
      "VALIDATION_ERROR",
      `${field} must be a valid opaque UUID identifier.`,
      { details: { field } },
    );
  }
  return normalized;
}

export function normalizeFollowTarget(
  targetType: unknown,
  targetId: unknown,
): FollowTarget {
  if (!isFollowTargetType(targetType) || typeof targetId !== "string") {
    throw new FollowError(
      "VALIDATION_ERROR",
      "The Follow target type or ID is invalid.",
      { details: { field: typeof targetId === "string" ? "target_type" : "target_id" } },
    );
  }

  if (targetType === "actor" || targetType === "content") {
    return {
      targetId: canonicalUuid(targetId, "target_id"),
      targetType,
    };
  }
  if (targetType === "symbol") {
    const normalized = targetId.normalize("NFC").trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(normalized)) {
      throw new FollowError(
        "VALIDATION_ERROR",
        "Symbol Follow targets must use the canonical market-symbol format.",
        { details: { field: "target_id" } },
      );
    }
    return { targetId: normalized, targetType };
  }

  const normalized = targetId.normalize("NFC").trim().toLowerCase();
  if (!TOPIC_PATTERN.test(normalized)) {
    throw new FollowError(
      "VALIDATION_ERROR",
      "Topic Follow targets must use the canonical topic-slug format.",
      { details: { field: "target_id" } },
    );
  }
  return { targetId: normalized, targetType };
}

function validateIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    [...value].length < 1 ||
    [...value].length > 200 ||
    value.trim().length === 0 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new FollowError(
      "VALIDATION_ERROR",
      "The idempotency key must be non-blank, control-free, and at most 200 characters.",
      { details: { field: "idempotency_key" } },
    );
  }
}

export function normalizeSetFollowCommand(
  input: SetFollowInput,
): NormalizedSetFollowCommand {
  if (typeof input.active !== "boolean") {
    throw new FollowError(
      "VALIDATION_ERROR",
      "The active target state must be a boolean.",
      { details: { field: "active" } },
    );
  }
  validateIdempotencyKey(input.idempotencyKey);
  if (
    input.notificationLevel !== undefined &&
    !isNotificationLevel(input.notificationLevel)
  ) {
    throw new FollowError(
      "VALIDATION_ERROR",
      "The notification level must be feed_only, new_posts, or all_events.",
      { details: { field: "notification_level" } },
    );
  }
  const target = normalizeFollowTarget(input.targetType, input.targetId);
  const notificationLevelProvided = input.active && input.notificationLevel !== undefined;
  return {
    active: input.active,
    idempotencyKey: input.idempotencyKey,
    notificationLevel: notificationLevelProvided
      ? (input.notificationLevel ?? null)
      : null,
    notificationLevelProvided,
    ...target,
  };
}

export function normalizeFollowListInput(
  input: FollowListInput,
  defaultLimit = DEFAULT_LIST_LIMIT,
): NormalizedFollowListInput {
  if (input.targetType !== undefined && !isFollowTargetType(input.targetType)) {
    throw new FollowError("INVALID_ARGUMENT", "The Follow target filter is invalid.");
  }
  const limit = input.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIST_LIMIT) {
    throw new FollowError("INVALID_ARGUMENT", "The Follow list limit is invalid.");
  }
  let cursor: string | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    if (
      typeof input.cursor !== "string" ||
      input.cursor.length < 1 ||
      input.cursor.length > MAXIMUM_CURSOR_LENGTH ||
      /\s/u.test(input.cursor)
    ) {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    cursor = input.cursor;
  }
  return {
    cursor,
    limit,
    targetType: input.targetType ?? null,
  };
}

function validateAuthorityContext(context: AgentCredentialContext): void {
  if (
    !isUuid(context.owner.id) ||
    !isUuid(context.agent.id) ||
    !isUuid(context.agent.actorId) ||
    !isUuid(context.credential.id) ||
    !isUuid(context.agent.policy.id) ||
    context.agent.ownerId !== context.owner.id ||
    context.credential.ownerId !== context.owner.id ||
    context.credential.agentId !== context.agent.id
  ) {
    throw new FollowError(
      "AUTHORIZATION_CONTEXT_STALE",
      "The authenticated Agent authority context is no longer valid.",
    );
  }
}

function validateRequestContext(request: FollowRequestContext): string {
  if (
    typeof request.requestId !== "string" ||
    request.requestId.trim().length === 0 ||
    request.requestId.length > 200 ||
    /\p{Cc}/u.test(request.requestId)
  ) {
    throw new FollowError("VALIDATION_ERROR", "The request ID is invalid.", {
      details: { field: "request_id" },
    });
  }
  const channel = request.channel ?? "rest";
  if (!/^[a-z][a-z0-9_.-]{0,59}$/u.test(channel)) {
    throw new FollowError("VALIDATION_ERROR", "The request channel is invalid.", {
      details: { field: "channel" },
    });
  }
  return channel;
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function digestInput(input: NormalizedSetFollowCommand): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        active: input.active,
        notification_level:
          input.active && input.notificationLevelProvided
            ? input.notificationLevel
            : null,
        notification_level_provided: input.active && input.notificationLevelProvided,
        operation: "set_follow",
        target_id: input.targetId,
        target_type: input.targetType,
        version: 1,
      }),
      "utf8",
    )
    .digest();
}

function policySnapshot(
  authorization: AuthorizationRow,
  evaluation: AgentOperationEvaluation,
  decisionId: string,
): postgres.JSONValue {
  return {
    credential_ceiling_decision: evaluation.credentialCeilingDecision,
    decision: evaluation.decision,
    decision_id: decisionId,
    defaults_version: authorization.defaults_version,
    matched_scope: evaluation.matchedScope,
    owner_policy_decision: evaluation.ownerPolicyDecision,
    policy_id: authorization.policy_id,
    policy_rule_source: evaluation.policyRuleSource,
    policy_schema_version: authorization.policy_schema_version,
    policy_tier: authorization.policy_tier,
    policy_version: authorization.policy_version,
    reason: evaluation.reason,
    required_scopes: [...evaluation.requiredScopes],
    scope_satisfied: evaluation.scopeSatisfied,
  };
}

function humanDirectFollowEvaluation(): AgentOperationEvaluation {
  return {
    credentialCeilingDecision: "allow",
    decision: "allow",
    matchedScope: null,
    ownerPolicyDecision: "allow",
    policyRuleSource: "tier_default",
    reason: "ALLOWED_BY_POLICY",
    requiredScopes: [],
    scopeSatisfied: true,
  };
}

function agentFollowPrincipal(
  context: AgentCredentialContext,
  authorization: AuthorizationRow,
  evaluation: AgentOperationEvaluation,
): FollowWritePrincipal {
  return {
    actorId: authorization.actor_id,
    actorKind: "agent",
    activatedAt: new Date(authorization.agent_activated_at.valueOf()),
    agentId: context.agent.id,
    approvalMethod: "policy_auto",
    authenticationAssurance: "agent_credential",
    authorizationSnapshot: (decisionId) =>
      policySnapshot(authorization, evaluation, decisionId),
    credentialId: context.credential.id,
    evaluation,
    ownerId: context.owner.id,
    policyVersion: authorization.policy_version,
    principalScopeKey: `credential:${context.credential.id}`,
  };
}

function ownerWebFollowPrincipal(authority: WebSocialAuthority): FollowWritePrincipal {
  if (authority.kind === "human_direct") {
    const evaluation = humanDirectFollowEvaluation();
    return {
      actorId: authority.actor.id,
      actorKind: "human",
      activatedAt: new Date(authority.actor.createdAt.valueOf()),
      agentId: null,
      approvalMethod: "human_direct",
      authenticationAssurance: authority.requestContext.authenticationAssurance,
      authorizationSnapshot: (decisionId) => ({
        actor_id: authority.actor.id,
        actor_kind: "human",
        approval_method: "human_direct",
        approved_by_owner_id: authority.owner.id,
        authenticated_at: authority.requestContext.authenticatedAt.toISOString(),
        authentication_assurance: authority.requestContext.authenticationAssurance,
        authority_checked_at: authority.authorityCheckedAt.toISOString(),
        csrf_validated: true,
        decision: evaluation.decision,
        decision_id: decisionId,
        human_direct: true,
        owner_id: authority.owner.id,
        principal_scope_key: authority.principalScopeKey,
      }),
      credentialId: null,
      evaluation,
      ownerId: authority.owner.id,
      policyVersion: null,
      principalScopeKey: authority.principalScopeKey,
    };
  }

  const direct = evaluateOwnerDirectOperation(authority, "set_follow");
  const policyRuleSource =
    authority.currentPolicy.tier === "custom"
      ? "custom_override"
      : authority.currentPolicy.tier === "assisted"
        ? "assisted_inheritance"
        : "tier_default";
  const evaluation: AgentOperationEvaluation = {
    credentialCeilingDecision: "allow",
    decision: direct.decision,
    matchedScope: null,
    ownerPolicyDecision: direct.ownerPolicyDecision,
    policyRuleSource,
    reason:
      direct.reason === "POLICY_DENIED" || direct.reason === "POLICY_RULES_UNAVAILABLE"
        ? direct.reason
        : direct.ownerPolicyDecision === "require_approval"
          ? "OWNER_APPROVAL_REQUIRED"
          : "ALLOWED_BY_POLICY",
    requiredScopes: [],
    scopeSatisfied: true,
  };
  return {
    actorId: authority.actor.id,
    actorKind: "agent",
    activatedAt: new Date(authority.agent.activatedAt.valueOf()),
    agentId: authority.agent.id,
    approvalMethod: "owner_direct",
    authenticationAssurance: authority.requestContext.authenticationAssurance,
    authorizationSnapshot: (decisionId) => ({
      actor_id: authority.actor.id,
      actor_kind: "agent",
      agent_id: authority.agent.id,
      approval_method: "owner_direct",
      approved_by_owner_id: authority.owner.id,
      authenticated_at: authority.requestContext.authenticatedAt.toISOString(),
      authentication_assurance: authority.requestContext.authenticationAssurance,
      authority_checked_at: authority.authorityCheckedAt.toISOString(),
      csrf_validated: true,
      decision: evaluation.decision,
      decision_id: decisionId,
      owner_id: authority.owner.id,
      owner_policy_decision: evaluation.ownerPolicyDecision,
      policy: {
        defaults_version: authority.currentPolicy.defaultsVersion,
        id: authority.currentPolicy.id,
        rule_source: evaluation.policyRuleSource,
        rules: authority.currentPolicy.rules,
        schema_version: authority.currentPolicy.schemaVersion,
        tier: authority.currentPolicy.tier,
        version: authority.currentPolicy.version,
      },
      principal_scope_key: authority.principalScopeKey,
    }),
    credentialId: null,
    evaluation,
    ownerId: authority.owner.id,
    policyVersion: authority.currentPolicy.version,
    principalScopeKey: authority.principalScopeKey,
  };
}

function rateLimitedOutcome(error: FollowError): FollowWriteOutcome {
  if (
    error.code !== "RATE_LIMITED" ||
    !error.retryable ||
    error.retryAfterMs === null ||
    !Number.isSafeInteger(error.retryAfterMs) ||
    error.retryAfterMs < 1
  ) {
    throw new Error("A RATE_LIMITED denial requires a positive retry interval.");
  }
  return {
    decision: "deny",
    error: error.toDetail(),
    operation: "set_follow",
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function errorOutcome(
  evaluation: AgentOperationEvaluation,
  error: FollowError,
): FollowWriteOutcome {
  if (error.code === "RATE_LIMITED") return rateLimitedOutcome(error);
  const decision = evaluation.decision === "allow" ? "allow" : "deny";
  return {
    decision,
    error: error.toDetail(),
    operation: "set_follow",
    pendingAction: null,
    replayed: false,
    result: null,
    status: decision === "deny" ? "denied" : "failed",
  };
}

function serializeOutcome(
  outcome: FollowWriteOutcome,
  resourceId: string | null,
): PersistedFollowOutcome {
  return {
    decision: outcome.decision,
    error:
      outcome.error === null
        ? null
        : {
            code: outcome.error.code,
            details: outcome.error.details,
            message: outcome.error.message,
            retry_after_ms: outcome.error.retryAfterMs,
            retryable: outcome.error.retryable,
          },
    operation: "set_follow",
    pending_action: null,
    resource_id: resourceId,
    result:
      outcome.result === null
        ? null
        : {
            active: outcome.result.active,
            notification_level: outcome.result.notificationLevel,
            target_id: outcome.result.targetId,
            target_type: outcome.result.targetType,
            updated_at: outcome.result.updatedAt.toISOString(),
          },
    status: outcome.status,
    version: 1,
  };
}

function parsePersistedOutcome(
  value: unknown,
  expected: {
    command: NormalizedSetFollowCommand;
    resourceId: string | null;
    responseCode: number | null;
    status: IdempotencyRow["status"];
  },
): FollowWriteOutcome {
  const corrupt = () =>
    new FollowError(
      "IDEMPOTENCY_RESULT_CORRUPT",
      "The stored Follow result is unavailable.",
      { retryable: true },
    );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "decision",
      "error",
      "operation",
      "pending_action",
      "resource_id",
      "result",
      "status",
      "version",
    ]) ||
    value.version !== 1 ||
    value.operation !== "set_follow" ||
    value.pending_action !== null ||
    (value.resource_id !== null &&
      (typeof value.resource_id !== "string" || !isUuid(value.resource_id))) ||
    (value.decision !== "allow" && value.decision !== "deny") ||
    (value.status !== "succeeded" &&
      value.status !== "denied" &&
      value.status !== "failed")
  ) {
    throw corrupt();
  }

  let result: SetFollowResult | null = null;
  if (value.result !== null) {
    if (
      !isRecord(value.result) ||
      !hasExactKeys(value.result, [
        "active",
        "notification_level",
        "target_id",
        "target_type",
        "updated_at",
      ]) ||
      typeof value.result.active !== "boolean" ||
      !isFollowTargetType(value.result.target_type) ||
      typeof value.result.target_id !== "string" ||
      (value.result.notification_level !== null &&
        !isNotificationLevel(value.result.notification_level)) ||
      value.result.active !== (value.result.notification_level !== null) ||
      typeof value.result.updated_at !== "string"
    ) {
      throw corrupt();
    }
    let canonical: FollowTarget;
    try {
      canonical = normalizeFollowTarget(value.result.target_type, value.result.target_id);
    } catch {
      throw corrupt();
    }
    if (
      canonical.targetType !== expected.command.targetType ||
      canonical.targetId !== expected.command.targetId
    ) {
      throw corrupt();
    }
    const updatedAt = new Date(value.result.updated_at);
    if (!Number.isFinite(updatedAt.valueOf())) throw corrupt();
    result = {
      active: value.result.active,
      notificationLevel: value.result.notification_level,
      targetId: canonical.targetId,
      targetType: canonical.targetType,
      updatedAt,
    };
  }

  let error: FollowErrorDetail | null = null;
  if (value.error !== null) {
    if (
      !isRecord(value.error) ||
      !hasExactKeys(value.error, [
        "code",
        "details",
        "message",
        "retry_after_ms",
        "retryable",
      ]) ||
      !isFollowErrorCode(value.error.code) ||
      typeof value.error.message !== "string" ||
      value.error.message.length < 1 ||
      value.error.message.length > 2_000 ||
      typeof value.error.retryable !== "boolean" ||
      (value.error.retry_after_ms !== null &&
        (!Number.isSafeInteger(value.error.retry_after_ms) ||
          Number(value.error.retry_after_ms) < 1)) ||
      (value.error.details !== null &&
        (!isRecord(value.error.details) ||
          !Object.values(value.error.details).every(
            (detail) =>
              detail === null ||
              typeof detail === "string" ||
              typeof detail === "number" ||
              typeof detail === "boolean",
          ))) ||
      value.error.code === "RATE_LIMITED"
    ) {
      throw corrupt();
    }
    error = {
      code: value.error.code,
      details: value.error.details as Record<
        string,
        string | number | boolean | null
      > | null,
      message: value.error.message,
      retryAfterMs:
        value.error.retry_after_ms === null ? null : Number(value.error.retry_after_ms),
      retryable: value.error.retryable,
    };
  }

  if (
    (value.status === "succeeded" && (result === null || error !== null)) ||
    (value.status !== "succeeded" && (result !== null || error === null)) ||
    (value.decision === "deny" && value.status !== "denied") ||
    (value.decision === "allow" && value.status === "denied") ||
    expected.status !== value.status ||
    (result !== null &&
      (result.active !== expected.command.active ||
        (expected.command.active &&
          expected.command.notificationLevelProvided &&
          result.notificationLevel !== expected.command.notificationLevel))) ||
    (value.status === "succeeded" &&
      (value.resource_id === null ||
        value.resource_id !== expected.resourceId ||
        expected.responseCode !== 200 ||
        expected.resourceId === null ||
        !isUuid(expected.resourceId) ||
        ((expected.command.targetType === "actor" ||
          expected.command.targetType === "content") &&
          expected.resourceId !== expected.command.targetId))) ||
    (value.status !== "succeeded" &&
      (value.resource_id !== null ||
        error === null ||
        expected.responseCode !== statusForError(error.code) ||
        expected.resourceId !== null))
  ) {
    throw corrupt();
  }

  return {
    decision: value.decision,
    error,
    operation: "set_follow",
    pendingAction: null,
    replayed: true,
    result,
    status: value.status,
  };
}

function keyedDigest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function cursorBinding(
  key: Buffer,
  context: AgentCredentialContext,
  input: NormalizedFollowListInput,
): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      query: { limit: input.limit, targetType: input.targetType },
      viewer: {
        actorId: context.agent.actorId,
        agentId: context.agent.id,
        credentialId: context.credential.id,
        ownerId: context.owner.id,
        policyId: context.agent.policy.id,
        policyVersion: context.agent.policy.version,
      },
    }),
  );
}

function makeSnapshotId(key: Buffer, binding: string, asOf: Date, epoch: string): string {
  return `fls_${keyedDigest(
    key,
    SNAPSHOT_ID_DOMAIN,
    JSON.stringify({ asOf: asOf.toISOString(), binding, epoch }),
  ).slice(0, 32)}`;
}

function decodeCursorPayload(value: unknown): FollowCursorPayload | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "asOf",
      "binding",
      "epoch",
      "expiresAt",
      "kind",
      "last",
      "snapshotId",
      "v",
    ]) ||
    value.v !== CURSOR_VERSION ||
    value.kind !== "follow-list" ||
    typeof value.asOf !== "string" ||
    typeof value.binding !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.binding) ||
    typeof value.epoch !== "string" ||
    !/^(?:0|[1-9][0-9]{0,19})$/u.test(value.epoch) ||
    typeof value.expiresAt !== "string" ||
    typeof value.snapshotId !== "string" ||
    !/^fls_[0-9a-f]{32}$/u.test(value.snapshotId) ||
    !isRecord(value.last) ||
    !hasExactKeys(value.last, ["id", "updatedAt"]) ||
    typeof value.last.id !== "string" ||
    !isUuid(value.last.id) ||
    typeof value.last.updatedAt !== "string"
  ) {
    return null;
  }
  return value as unknown as FollowCursorPayload;
}

function assertListAllowed(context: AgentCredentialContext): void {
  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: context.credential.policyCeiling,
    credentialPolicyCeilingDefaultsVersion:
      context.credential.policyCeilingDefaultsVersion,
    credentialPolicyCeilingRules: context.credential.policyCeilingRules,
    credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
    operation: "list_follows",
    policyDefaultsVersion: context.agent.policy.defaultsVersion,
    policyRules: context.agent.policy.rules,
    policySchemaVersion: context.agent.policy.schemaVersion,
    policyTier: context.agent.policy.tier,
    scopes: context.credential.scopes,
  });
  if (!evaluation.scopeSatisfied) {
    throw new FollowError(
      "SCOPE_REQUIRED",
      "The Agent credential lacks the research:read scope.",
    );
  }
  if (evaluation.decision === "deny") {
    throw new FollowError(
      "POLICY_DENIED",
      "The Agent policy does not permit reading the Follow graph.",
    );
  }
}

export class PostgresFollowService implements FollowService, OwnerWebFollowService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #cursorTtlMilliseconds: number;
  readonly #defaultListLimit: number;
  readonly #idFactory: () => string;
  readonly #idempotencyRetentionMs: number;
  readonly #queryTimeoutMilliseconds: number;
  readonly #sql: PostgresClient;
  readonly #webSocialAuthorityResolver: WebSocialAuthorityResolver | null;

  constructor(sql: PostgresClient, options: PostgresFollowServiceOptions) {
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#idempotencyRetentionMs =
      options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    this.#defaultListLimit = options.defaultListLimit ?? DEFAULT_LIST_LIMIT;
    this.#cursorTtlMilliseconds =
      (options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS) * 1_000;
    this.#queryTimeoutMilliseconds =
      options.queryTimeoutMilliseconds ?? DEFAULT_QUERY_TIMEOUT_MILLISECONDS;
    this.#webSocialAuthorityResolver = options.webSocialAuthorityResolver ?? null;
    if (
      !Buffer.isBuffer(options.cursorSigningKey) ||
      options.cursorSigningKey.length < 32
    ) {
      throw new Error("The Follow cursor signing key must contain at least 32 bytes.");
    }
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    if (
      !Number.isSafeInteger(this.#idempotencyRetentionMs) ||
      this.#idempotencyRetentionMs < IDEMPOTENCY_MIN_RETENTION_MS
    ) {
      throw new RangeError("Follow idempotency retention must be at least 7 days.");
    }
    const integerOptions: Array<[number, number, number, string]> = [
      [this.#defaultListLimit, 1, MAXIMUM_LIST_LIMIT, "list limit"],
      [options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS, 60, 86_400, "cursor TTL"],
      [this.#queryTimeoutMilliseconds, 100, 10_000, "query timeout"],
    ];
    for (const [value, minimum, maximum, label] of integerOptions) {
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(
          `The Follow ${label} must be between ${minimum} and ${maximum}.`,
        );
      }
    }
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = ${FOLLOW_GRAPH_MIGRATION_VERSION}
              and name = ${FOLLOW_GRAPH_MIGRATION_NAME}
              and checksum = ${FOLLOW_GRAPH_MIGRATION_CHECKSUM}
          )
          and exists (
            select 1
            from system.schema_migrations
            where version = '000010'
              and name = 'agent_policy_control'
              and checksum = ${AGENT_POLICY_CONTROL_MIGRATION_CHECKSUM}
          )
          and exists (
            select 1
            from system.schema_migrations
            where version = '000026'
              and checksum =
                ${PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.community_write_controls') is not null
          and to_regclass('platform.follows') is not null
          and to_regclass('system.actor_follow_epochs') is not null
          and to_regclass(
            'platform.follows_follower_actor_target_unique'
          ) is not null
          and to_regclass(
            'platform.follows_follower_symbol_target_unique'
          ) is not null
          and to_regclass(
            'platform.follows_follower_topic_target_unique'
          ) is not null
          and to_regclass(
            'platform.follows_follower_content_target_unique'
          ) is not null
          and to_regclass('platform.follows_follower_updated_idx') is not null
          and to_regclass('platform.follows_target_actor_reverse_idx') is not null
          and to_regclass('platform.follows_target_symbol_reverse_idx') is not null
          and to_regclass('platform.follows_target_topic_reverse_idx') is not null
          and to_regclass('platform.follows_target_content_reverse_idx') is not null
          and to_regclass(
            'platform.action_logs_follow_succeeded_agent_occurred_idx'
          ) is not null
          and (
            select count(*)
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.follows')
              and attname in (
                'id',
                'follower_actor_id',
                'target_type',
                'target_actor_id',
                'target_symbol_id',
                'target_topic_id',
                'target_content_id',
                'notification_level',
                'created_at',
                'updated_at'
              )
              and attnotnull = (attname in (
                'id',
                'follower_actor_id',
                'target_type',
                'notification_level',
                'created_at',
                'updated_at'
              ))
              and not attisdropped
          ) = 10
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.follows')
              and tgname = 'follows_validate_write'
              and tgfoid = to_regprocedure('platform.validate_follow_write()')
              and tgtype = 23
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.follows')
              and tgname = 'follows_prepare_update'
              and tgfoid = to_regprocedure('platform.prepare_follow_update()')
              and tgtype = 19
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.follows')
              and tgname = 'follows_advance_actor_epoch'
              and tgfoid = to_regprocedure('platform.advance_actor_follow_epoch()')
              and tgtype = 29
              and not tgisinternal
              and tgenabled in ('O', 'A')
          ) as ready
      `;
    });
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new FollowError("FOLLOW_NOT_READY", "The Follow graph schema is not ready.", {
        retryable: true,
      });
    }
  }

  async listFollows(
    context: AgentCredentialContext,
    input: FollowListInput,
  ): Promise<FollowListPage> {
    validateAuthorityContext(context);
    assertListAllowed(context);
    const normalized = normalizeFollowListInput(input, this.#defaultListLimit);
    const binding = cursorBinding(this.#cursorSigningKey, context, normalized);
    const cursor =
      normalized.cursor === null ? null : this.#parseCursor(normalized.cursor, binding);
    const now = new Date(this.#clock().valueOf());
    if (!Number.isFinite(now.valueOf())) {
      throw new Error("The Follow clock returned an invalid Date.");
    }
    const result = await this.#sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const asOf = cursor?.asOf ?? (await this.#databaseTime(transaction));
        const epoch = await this.#actorEpoch(transaction, context.agent.actorId);
        if (cursor !== null && cursor.epoch !== epoch) {
          throw new FollowError(
            "SNAPSHOT_EXPIRED",
            "The Follow graph changed during pagination.",
          );
        }
        const rows = await this.#selectFollowList(
          transaction,
          context.agent.actorId,
          normalized,
          asOf,
          cursor,
        );
        return { asOf, epoch, rows };
      },
    );
    const hasMore = result.rows.length > normalized.limit;
    const pageRows = result.rows.slice(0, normalized.limit);
    const items = pageRows.map((row) => this.#mapFollowListRow(row));
    const snapshotId =
      cursor?.snapshotId ??
      makeSnapshotId(this.#cursorSigningKey, binding, result.asOf, result.epoch);
    const expiresAt =
      cursor?.expiresAt ?? new Date(result.asOf.valueOf() + this.#cursorTtlMilliseconds);
    const last = pageRows.at(-1);
    return {
      items,
      ordering: {
        asOf: result.asOf,
        orderingVersion: FOLLOW_LIST_ORDERING_VERSION,
        snapshotId,
      },
      page: {
        hasMore,
        limit: normalized.limit,
        nextCursor:
          hasMore && last
            ? this.#createCursor({
                asOf: result.asOf,
                binding,
                epoch: result.epoch,
                expiresAt,
                lastId: last.id,
                lastUpdatedAt: asDate(last.updated_at, "FOLLOW_DATA_INVALID"),
                snapshotId,
              })
            : null,
      },
    };
  }

  async setFollow(
    context: AgentCredentialContext,
    input: SetFollowInput,
    request: FollowRequestContext,
  ): Promise<FollowWriteOutcome> {
    validateAuthorityContext(context);
    const preliminary = evaluateAgentOperation({
      credentialPolicyCeiling: context.credential.policyCeiling,
      credentialPolicyCeilingDefaultsVersion:
        context.credential.policyCeilingDefaultsVersion,
      credentialPolicyCeilingRules: context.credential.policyCeilingRules,
      credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
      operation: "set_follow",
      policyDefaultsVersion: context.agent.policy.defaultsVersion,
      policyRules: context.agent.policy.rules,
      policySchemaVersion: context.agent.policy.schemaVersion,
      policyTier: context.agent.policy.tier,
      scopes: context.credential.scopes,
    });
    if (!preliminary.scopeSatisfied) {
      throw new FollowError(
        "SCOPE_REQUIRED",
        "The Agent credential lacks the follow:write scope.",
      );
    }

    let currentEvaluation = preliminary;
    try {
      const command = normalizeSetFollowCommand(input);
      const channel = validateRequestContext(request);
      const digest = digestInput(command);
      return await this.#sql.begin(async (transaction) => {
        await this.#setStatementTimeout(transaction, 10_000);
        const authorization = await this.#loadAuthorization(transaction, context);
        currentEvaluation = evaluateAgentOperation({
          credentialPolicyCeiling: authorization.credential_policy_ceiling,
          credentialPolicyCeilingDefaultsVersion:
            authorization.credential_policy_ceiling_defaults_version,
          credentialPolicyCeilingRules: authorization.credential_policy_ceiling_rules,
          credentialPolicyCeilingSchemaVersion:
            authorization.credential_policy_ceiling_schema_version,
          operation: "set_follow",
          policyDefaultsVersion: authorization.defaults_version,
          policyRules: authorization.policy_rules,
          policySchemaVersion: authorization.policy_schema_version,
          policyTier: authorization.policy_tier,
          scopes: authorization.credential_scopes,
        });
        if (!currentEvaluation.scopeSatisfied) {
          throw new FollowError(
            "SCOPE_REQUIRED",
            "The Agent credential lacks the follow:write scope.",
          );
        }
        const principal = agentFollowPrincipal(context, authorization, currentEvaluation);
        return this.#executeFollow(transaction, {
          channel,
          command,
          digest,
          principal,
          requestId: request.requestId,
        });
      });
    } catch (error) {
      if (error instanceof FollowError) {
        return errorOutcome(currentEvaluation, error);
      }
      throw error;
    }
  }

  async setFollowAsOwnerWeb(
    context: OwnerWebMutationContext,
    selection: WebSocialAuthoritySelection,
    input: SetFollowInput,
  ): Promise<FollowWriteOutcome> {
    const resolver = this.#webSocialAuthorityResolver;
    if (!resolver) {
      throw new Error("The Owner Web social authority resolver is unavailable.");
    }
    let currentEvaluation = humanDirectFollowEvaluation();
    try {
      const command = normalizeSetFollowCommand(input);
      const channel = validateRequestContext({
        channel: "web",
        requestId: context.requestId,
      });
      const digest = digestInput(command);
      return await this.#sql.begin(async (transaction) => {
        await this.#setStatementTimeout(transaction, 10_000);
        const authority = await resolver.resolveAuthorityInTransaction(
          transaction,
          context,
          selection,
        );
        const principal = ownerWebFollowPrincipal(authority);
        currentEvaluation = principal.evaluation;
        return this.#executeFollow(transaction, {
          channel,
          command,
          digest,
          principal,
          requestId: context.requestId,
        });
      });
    } catch (error) {
      if (error instanceof FollowError) {
        return errorOutcome(currentEvaluation, error);
      }
      throw error;
    }
  }

  async #executeFollow(
    transaction: TransactionSql,
    input: {
      channel: string;
      command: NormalizedSetFollowCommand;
      digest: Buffer;
      principal: FollowWritePrincipal;
      requestId: string;
    },
  ): Promise<FollowWriteOutcome> {
    const { command, principal } = input;
    await this.#lockIdempotency(
      transaction,
      principal.principalScopeKey,
      command.idempotencyKey,
    );
    const existing = await this.#findIdempotency(
      transaction,
      principal.principalScopeKey,
      command.idempotencyKey,
    );
    if (existing) {
      if (!sameDigest(existing.request_digest, input.digest)) {
        throw new FollowError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used with different normalized input.",
        );
      }
      if (existing.status === "admission_reserved" || existing.status === "in_progress") {
        throw new FollowError(
          "IDEMPOTENCY_IN_PROGRESS",
          "The original Follow command is still in progress.",
          { retryable: true },
        );
      }
      return parsePersistedOutcome(existing.response_body, {
        command,
        resourceId: existing.resource_id,
        responseCode: existing.response_code,
        status: existing.status,
      });
    }

    const writeControl = await readCommunityWriteControl(transaction);
    if (writeControl.mode === "paused") {
      throw new FollowError(
        "PLATFORM_WRITE_PAUSED",
        "Community writes are temporarily paused.",
        {
          details: {
            control_version: writeControl.version,
            reason_code: writeControl.pauseReasonCode!,
          },
          retryable: true,
        },
      );
    }

    const now = new Date(this.#clock().valueOf());
    if (!Number.isFinite(now.valueOf())) {
      throw new Error("The Follow clock returned an invalid Date.");
    }
    const decisionId = this.#newId("decision_id");

    if (principal.evaluation.decision !== "allow") {
      const idempotencyId = this.#newId("idempotency_record_id");
      await this.#insertIdempotency(transaction, {
        digest: input.digest,
        id: idempotencyId,
        idempotencyKey: command.idempotencyKey,
        principal,
      });
      const denied = errorOutcome(
        principal.evaluation,
        new FollowError(
          "POLICY_DENIED",
          "The selected Agent policy does not permit Follow writes.",
          { details: { reason: principal.evaluation.reason } },
        ),
      );
      await this.#commitFailure(transaction, {
        channel: input.channel,
        decisionId,
        idempotencyId,
        input: command,
        now,
        outcome: denied,
        principal,
        rateRuleApplied: false,
        requestId: input.requestId,
      });
      return denied;
    }

    try {
      await this.#enforceFollowRate(transaction, principal, now);
    } catch (error) {
      if (error instanceof FollowError && error.code === "RATE_LIMITED") {
        const denied = rateLimitedOutcome(error);
        await this.#commitTransientRateLimit(transaction, {
          channel: input.channel,
          decisionId,
          input: command,
          now,
          outcome: denied,
          principal,
          requestId: input.requestId,
        });
        return denied;
      }
      throw error;
    }

    const idempotencyId = this.#newId("idempotency_record_id");
    await this.#insertIdempotency(transaction, {
      digest: input.digest,
      id: idempotencyId,
      idempotencyKey: command.idempotencyKey,
      principal,
    });

    try {
      return await transaction.savepoint(
        "follow_write_admission",
        async (admissionTransaction) =>
          this.#commitFollow(admissionTransaction, {
            channel: input.channel,
            decisionId,
            idempotencyId,
            input: command,
            now,
            principal,
            requestId: input.requestId,
          }),
      );
    } catch (error) {
      if (error instanceof FollowError) {
        const failed = errorOutcome(principal.evaluation, error);
        await this.#commitFailure(transaction, {
          channel: input.channel,
          decisionId,
          idempotencyId,
          input: command,
          now,
          outcome: failed,
          principal,
          rateRuleApplied: true,
          requestId: input.requestId,
        });
        return failed;
      }
      throw error;
    }
  }

  #newId(field: string): string {
    const value = this.#idFactory();
    if (!isUuid(value)) {
      throw new Error(`The configured ID factory returned an invalid ${field}.`);
    }
    return value;
  }

  async #setStatementTimeout(
    sql: QuerySql,
    timeout = this.#queryTimeoutMilliseconds,
  ): Promise<void> {
    await sql`select set_config('statement_timeout', ${String(timeout)}, true)`;
  }

  async #databaseTime(sql: QuerySql): Promise<Date> {
    const rows = await sql<DatabaseTimeRow[]>`
      select clock_timestamp() as as_of
    `;
    if (rows.length !== 1) {
      throw new FollowError(
        "FOLLOW_DATA_INVALID",
        "The Follow list clock projection is invalid.",
        { retryable: true },
      );
    }
    return asDate(rows[0]?.as_of, "FOLLOW_DATA_INVALID");
  }

  async #actorEpoch(sql: QuerySql, actorId: string): Promise<string> {
    const rows = await sql<EpochRow[]>`
      select coalesce((
        select epoch::text
        from system.actor_follow_epochs
        where actor_id = ${actorId}
      ), '0') as epoch
    `;
    const epoch = rows[0]?.epoch;
    if (
      rows.length !== 1 ||
      typeof epoch !== "string" ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(epoch)
    ) {
      throw new FollowError("FOLLOW_DATA_INVALID", "The Follow graph epoch is invalid.", {
        retryable: true,
      });
    }
    return epoch;
  }

  async #selectFollowList(
    sql: QuerySql,
    actorId: string,
    input: NormalizedFollowListInput,
    asOf: Date,
    cursor: ParsedFollowCursor | null,
  ): Promise<FollowListRow[]> {
    return sql<FollowListRow[]>`
      select
        follow.id::text as id,
        follow.target_type,
        case follow.target_type
          when 'actor' then follow.target_actor_id::text
          when 'symbol' then symbol.ticker::text
          when 'topic' then topic.slug::text
          when 'content' then follow.target_content_id::text
        end as target_id,
        follow.notification_level,
        follow.created_at,
        follow.updated_at
      from platform.follows as follow
      left join platform.symbols as symbol
        on symbol.id = follow.target_symbol_id
      left join platform.topics as topic
        on topic.id = follow.target_topic_id
      where follow.follower_actor_id = ${actorId}
        and follow.updated_at <= ${asOf}
        and (
          ${input.targetType}::text is null
          or follow.target_type = ${input.targetType}
        )
        and (
          ${cursor?.lastUpdatedAt ?? null}::timestamptz is null
          or (follow.updated_at, follow.id) < (
            ${cursor?.lastUpdatedAt ?? null}::timestamptz,
            ${cursor?.lastId ?? null}::uuid
          )
        )
      order by follow.updated_at desc, follow.id desc
      limit ${input.limit + 1}
    `;
  }

  #mapFollowListRow(row: FollowListRow): FollowProjection {
    if (
      !isUuid(row.id) ||
      !isFollowTargetType(row.target_type) ||
      typeof row.target_id !== "string" ||
      !isNotificationLevel(row.notification_level)
    ) {
      throw new FollowError(
        "FOLLOW_DATA_INVALID",
        "Stored Follow data could not be projected safely.",
        { retryable: true },
      );
    }
    let target: FollowTarget;
    try {
      target = normalizeFollowTarget(row.target_type, row.target_id);
    } catch {
      throw new FollowError(
        "FOLLOW_DATA_INVALID",
        "Stored Follow target data is invalid.",
        { retryable: true },
      );
    }
    const createdAt = asDate(row.created_at, "FOLLOW_DATA_INVALID");
    const updatedAt = asDate(row.updated_at, "FOLLOW_DATA_INVALID");
    if (updatedAt < createdAt) {
      throw new FollowError(
        "FOLLOW_DATA_INVALID",
        "Stored Follow timestamps are inconsistent.",
        { retryable: true },
      );
    }
    return {
      createdAt,
      followId: row.id,
      notificationLevel: row.notification_level,
      ...target,
      updatedAt,
    };
  }

  #createCursor(options: {
    asOf: Date;
    binding: string;
    epoch: string;
    expiresAt: Date;
    lastId: string;
    lastUpdatedAt: Date;
    snapshotId: string;
  }): string {
    const payload: FollowCursorPayload = {
      asOf: options.asOf.toISOString(),
      binding: options.binding,
      epoch: options.epoch,
      expiresAt: options.expiresAt.toISOString(),
      kind: "follow-list",
      last: {
        id: options.lastId,
        updatedAt: options.lastUpdatedAt.toISOString(),
      },
      snapshotId: options.snapshotId,
      v: CURSOR_VERSION,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\u0000", "utf8")
      .update(body, "utf8")
      .digest("base64url");
    const cursor = `${body}.${signature}`;
    if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
      throw new FollowError(
        "FOLLOW_DATA_INVALID",
        "The Follow cursor exceeded its safety budget.",
        { retryable: true },
      );
    }
    return cursor;
  }

  #parseCursor(value: string, binding: string): ParsedFollowCursor {
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra !== undefined) {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    const expected = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\u0000", "utf8")
      .update(body, "utf8")
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    const payload = decodeCursorPayload(decoded);
    if (payload === null || payload.binding !== binding) {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    const asOf = new Date(payload.asOf);
    const expiresAt = new Date(payload.expiresAt);
    const lastUpdatedAt = new Date(payload.last.updatedAt);
    if (
      !Number.isFinite(asOf.valueOf()) ||
      !Number.isFinite(expiresAt.valueOf()) ||
      !Number.isFinite(lastUpdatedAt.valueOf()) ||
      lastUpdatedAt > asOf ||
      expiresAt <= asOf
    ) {
      throw new FollowError("CURSOR_INVALID", "The Follow list cursor is invalid.");
    }
    const now = new Date(this.#clock().valueOf());
    if (!Number.isFinite(now.valueOf())) {
      throw new Error("The Follow clock returned an invalid Date.");
    }
    if (now >= expiresAt) {
      throw new FollowError("CURSOR_EXPIRED", "The Follow list cursor has expired.");
    }
    return {
      asOf,
      epoch: payload.epoch,
      expiresAt,
      lastId: payload.last.id.toLowerCase(),
      lastUpdatedAt,
      snapshotId: payload.snapshotId,
    };
  }

  async #loadAuthorization(
    transaction: TransactionSql,
    context: AgentCredentialContext,
  ): Promise<AuthorizationRow> {
    const owners = await transaction<{ id: string }[]>`
      select owner.id::text as id
      from platform.owners as owner
      where owner.id = ${context.owner.id}
      for share
    `;
    if (!owners[0]) {
      throw new FollowError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    const rows = await transaction<AuthorizationRow[]>`
      select
        actor.id::text as actor_id,
        agent.activated_at as agent_activated_at,
        credential.scopes as credential_scopes,
        credential.policy_ceiling as credential_policy_ceiling,
        credential.policy_ceiling_defaults_version
          as credential_policy_ceiling_defaults_version,
        credential.policy_ceiling_schema_version
          as credential_policy_ceiling_schema_version,
        credential.policy_ceiling_rules as credential_policy_ceiling_rules,
        policy.id::text as policy_id,
        policy.tier as policy_tier,
        policy.defaults_version,
        policy.policy_schema_version,
        policy.version::text as policy_version,
        policy.rules as policy_rules
      from platform.credentials as credential
      join platform.agents as agent
        on agent.id = credential.agent_id
       and agent.owner_id = credential.owner_id
      join platform.actors as actor
        on actor.id = agent.actor_id
       and actor.owner_id = agent.owner_id
      join platform.owners as owner on owner.id = credential.owner_id
      join platform.agent_policies as policy
        on policy.agent_id = agent.id
       and policy.is_active
      where credential.id = ${context.credential.id}
        and credential.owner_id = ${context.owner.id}
        and credential.agent_id = ${context.agent.id}
        and actor.id = ${context.agent.actorId}
        and policy.id = ${context.agent.policy.id}
        and policy.version = ${context.agent.policy.version}
        and credential.revoked_at is null
        and (credential.expires_at is null or credential.expires_at > clock_timestamp())
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
        and agent.status = 'active'
        and agent.activated_at is not null
        and agent.deleted_at is null
        and actor.status = 'active'
        and actor.deleted_at is null
      limit 1
      for share of credential, agent, actor, owner, policy
    `;
    const row = rows[0];
    if (!row) {
      throw new FollowError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    return row;
  }

  async #lockIdempotency(
    transaction: TransactionSql,
    principalScopeKey: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`alphanet:idempotency:${principalScopeKey}:set_follow:${idempotencyKey}`},
          0
        )
      )
    `;
  }

  async #findIdempotency(
    transaction: TransactionSql,
    principalScopeKey: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRow | null> {
    const rows = await transaction<IdempotencyRow[]>`
      select
        request_digest,
        resource_id::text as resource_id,
        response_body,
        response_code,
        status
      from platform.idempotency_records
      where principal_scope_key = ${principalScopeKey}
        and operation = 'set_follow'
        and idempotency_key = ${idempotencyKey}
      limit 1
      for update
    `;
    return rows[0] ?? null;
  }

  async #insertIdempotency(
    transaction: TransactionSql,
    input: {
      digest: Buffer;
      id: string;
      idempotencyKey: string;
      principal: FollowWritePrincipal;
    },
  ): Promise<void> {
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
      select
        ${input.id},
        ${input.principal.principalScopeKey},
        ${input.principal.ownerId},
        ${input.principal.agentId},
        ${input.principal.actorId},
        ${input.principal.credentialId},
        'set_follow',
        ${input.idempotencyKey},
        ${input.digest},
        'in_progress',
        database_time.value,
        database_time.value,
        database_time.value
          + ${this.#idempotencyRetentionMs} * interval '1 millisecond'
      from (
        select clock_timestamp() as value
      ) as database_time
    `;
  }

  async #enforceFollowRate(
    transaction: TransactionSql,
    principal: FollowWritePrincipal,
    now: Date,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`alphanet:follow-write:${principal.actorId}`},
          0
        )
      )
    `;
    const windowStart = new Date(now.valueOf() - FOLLOW_RATE_WINDOW_MS);
    const rows = await transaction<FollowRateRow[]>`
      select
        count(*)::integer as follow_count,
        min(action.occurred_at) + interval '1 hour' as retry_at
      from platform.action_logs as action
      where action.actor_id = ${principal.actorId}
        and action.action = 'follow.set'
        and action.outcome = 'succeeded'
        and action.occurred_at >= ${windowStart}
    `;
    const row = rows[0];
    if (!row || !Number.isInteger(row.follow_count) || row.follow_count < 0) {
      throw new Error("Follow quota projection returned invalid data.");
    }
    const activatedAt = asDate(principal.activatedAt, "AUTHORIZATION_CONTEXT_STALE");
    const isNewAgent = now.valueOf() - activatedAt.valueOf() < NEW_AGENT_WINDOW_MS;
    const limit = isNewAgent
      ? NEW_AGENT_FOLLOWS_PER_HOUR
      : ESTABLISHED_AGENT_FOLLOWS_PER_HOUR;
    if (row.follow_count >= limit) {
      const retryAt = row.retry_at?.valueOf() ?? now.valueOf() + FOLLOW_RATE_WINDOW_MS;
      throw new FollowError(
        "RATE_LIMITED",
        "The Actor Follow command limit for this rolling hour has been reached.",
        {
          details: {
            limit,
            limit_dimension:
              principal.actorKind === "agent" ? "agent_follow_hour" : "human_follow_hour",
            new_agent_window: isNewAgent,
            rule_version: FOLLOW_RATE_RULE_VERSION,
          },
          retryAfterMs: Math.max(1, retryAt - now.valueOf()),
          retryable: true,
        },
      );
    }
  }

  async #resolveTarget(
    transaction: TransactionSql,
    followerActorId: string,
    input: NormalizedSetFollowCommand,
  ): Promise<ResolvedTarget> {
    switch (input.targetType) {
      case "actor":
        return this.#resolveActorTarget(transaction, followerActorId, input);
      case "symbol":
        return this.#resolveSymbolTarget(transaction, followerActorId, input);
      case "topic":
        return this.#resolveTopicTarget(transaction, input);
      case "content":
        return this.#resolveContentTarget(transaction, input);
    }
  }

  async #resolveActorTarget(
    transaction: TransactionSql,
    followerActorId: string,
    input: NormalizedSetFollowCommand,
  ): Promise<ResolvedTarget> {
    const rows = await transaction<ActorTargetRow[]>`
      select id::text as id, status, deleted_at
      from platform.actors
      where id = ${input.targetId}
      limit 1
      for share
    `;
    const row = rows[0];
    if (!row) {
      throw new FollowError("TARGET_NOT_FOUND", "The requested Actor was not found.");
    }
    if (input.active && row.id === followerActorId) {
      throw new FollowError("SELF_FOLLOW_NOT_ALLOWED", "An Actor cannot follow itself.");
    }
    if (input.active && (row.status !== "active" || row.deleted_at !== null)) {
      throw new FollowError(
        "TARGET_NOT_VISIBLE",
        "The requested Actor is not available for Follow.",
      );
    }
    return { resourceId: row.id, targetId: row.id, targetType: "actor" };
  }

  async #resolveSymbolTarget(
    transaction: TransactionSql,
    followerActorId: string,
    input: NormalizedSetFollowCommand,
  ): Promise<ResolvedTarget> {
    const rows = await transaction<SymbolTargetRow[]>`
      select
        symbol.id::text as id,
        symbol.ticker::text as ticker,
        symbol.status,
        exists (
          select 1
          from platform.follows as follow
          where follow.follower_actor_id = ${followerActorId}
            and follow.target_type = 'symbol'
            and follow.target_symbol_id = symbol.id
        ) as followed
      from platform.symbols as symbol
      where symbol.ticker = ${input.targetId}
      order by followed desc, symbol.id
      for share of symbol
    `;
    if (rows.length === 0) {
      throw new FollowError("TARGET_NOT_FOUND", "The requested Symbol was not found.");
    }
    const followed = rows.filter((row) => row.followed);
    const active = rows.filter((row) => row.status === "active");
    if (
      followed.length > 1 ||
      (input.active && active.length > 1) ||
      (!input.active && followed.length === 0 && active.length > 1)
    ) {
      throw new FollowError(
        "TARGET_AMBIGUOUS",
        "The Symbol ticker does not identify exactly one canonical target.",
      );
    }
    const activeTarget = active[0];
    const followedTarget = followed[0];
    if (
      input.active &&
      activeTarget !== undefined &&
      followedTarget !== undefined &&
      activeTarget.id !== followedTarget.id
    ) {
      throw new FollowError(
        "TARGET_AMBIGUOUS",
        "The existing Symbol relationship does not match the active canonical target.",
      );
    }
    const row = input.active ? activeTarget : (followedTarget ?? activeTarget);
    if (!row) {
      throw new FollowError(
        "TARGET_NOT_VISIBLE",
        "The requested Symbol is not available for Follow.",
      );
    }
    if (input.active && row.status !== "active") {
      throw new FollowError(
        "TARGET_NOT_VISIBLE",
        "The requested Symbol is not available for Follow.",
      );
    }
    return { resourceId: row.id, targetId: row.ticker, targetType: "symbol" };
  }

  async #resolveTopicTarget(
    transaction: TransactionSql,
    input: NormalizedSetFollowCommand,
  ): Promise<ResolvedTarget> {
    const rows = await transaction<TopicTargetRow[]>`
      select id::text as id, slug::text as slug, deleted_at
      from platform.topics
      where slug = ${input.targetId}
      limit 1
      for share
    `;
    const row = rows[0];
    if (!row) {
      throw new FollowError("TARGET_NOT_FOUND", "The requested Topic was not found.");
    }
    if (input.active && row.deleted_at !== null) {
      throw new FollowError(
        "TARGET_NOT_VISIBLE",
        "The requested Topic is not available for Follow.",
      );
    }
    return { resourceId: row.id, targetId: row.slug, targetType: "topic" };
  }

  async #resolveContentTarget(
    transaction: TransactionSql,
    input: NormalizedSetFollowCommand,
  ): Promise<ResolvedTarget> {
    const rows = await transaction<ContentTargetRow[]>`
      select
        content.id::text as id,
        content.lifecycle_state as content_lifecycle_state,
        content.distribution_state as content_distribution_state,
        root.lifecycle_state as root_lifecycle_state,
        root.distribution_state as root_distribution_state,
        community.status as community_status,
        community.deleted_at as community_deleted_at
      from platform.content_items as content
      join platform.content_items as root on root.id = content.root_id
      join platform.communities as community
        on community.id = root.primary_community_id
      where content.id = ${input.targetId}
      limit 1
      for share of content, root, community
    `;
    const row = rows[0];
    if (!row) {
      throw new FollowError("TARGET_NOT_FOUND", "The requested Content was not found.");
    }
    if (
      input.active &&
      (row.content_lifecycle_state !== "published" ||
        row.root_lifecycle_state !== "published" ||
        row.content_distribution_state === "hidden" ||
        row.root_distribution_state === "hidden" ||
        row.community_status === "suspended" ||
        row.community_deleted_at !== null)
    ) {
      throw new FollowError(
        "TARGET_NOT_VISIBLE",
        "The requested Content is not available for Follow.",
      );
    }
    return { resourceId: row.id, targetId: row.id, targetType: "content" };
  }

  async #findFollow(
    transaction: TransactionSql,
    followerActorId: string,
    target: ResolvedTarget,
  ): Promise<FollowRow | null> {
    let rows: FollowRow[];
    switch (target.targetType) {
      case "actor":
        rows = await transaction<FollowRow[]>`
          select id::text as id, notification_level, created_at, updated_at
          from platform.follows
          where follower_actor_id = ${followerActorId}
            and target_type = 'actor'
            and target_actor_id = ${target.resourceId}
          limit 1
          for update
        `;
        break;
      case "symbol":
        rows = await transaction<FollowRow[]>`
          select id::text as id, notification_level, created_at, updated_at
          from platform.follows
          where follower_actor_id = ${followerActorId}
            and target_type = 'symbol'
            and target_symbol_id = ${target.resourceId}
          limit 1
          for update
        `;
        break;
      case "topic":
        rows = await transaction<FollowRow[]>`
          select id::text as id, notification_level, created_at, updated_at
          from platform.follows
          where follower_actor_id = ${followerActorId}
            and target_type = 'topic'
            and target_topic_id = ${target.resourceId}
          limit 1
          for update
        `;
        break;
      case "content":
        rows = await transaction<FollowRow[]>`
          select id::text as id, notification_level, created_at, updated_at
          from platform.follows
          where follower_actor_id = ${followerActorId}
            and target_type = 'content'
            and target_content_id = ${target.resourceId}
          limit 1
          for update
        `;
        break;
    }
    return rows[0] ?? null;
  }

  async #assertCardinalityAvailable(
    transaction: TransactionSql,
    followerActorId: string,
  ): Promise<void> {
    const rows = await transaction<FollowCardinalityRow[]>`
      select count(*)::integer as follow_count
      from platform.follows
      where follower_actor_id = ${followerActorId}
    `;
    const count = rows[0]?.follow_count;
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new Error("Follow cardinality projection returned invalid data.");
    }
    if (Number(count) >= FOLLOW_CARDINALITY_LIMIT) {
      throw new FollowError(
        "FOLLOW_LIMIT_REACHED",
        "The Actor active Follow limit has been reached.",
        {
          details: {
            limit: FOLLOW_CARDINALITY_LIMIT,
            limit_dimension: "actor_active_follows",
            rule_version: FOLLOW_CARDINALITY_RULE_VERSION,
          },
        },
      );
    }
  }

  async #commitFollow(
    transaction: TransactionSql,
    input: {
      channel: string;
      decisionId: string;
      idempotencyId: string;
      input: NormalizedSetFollowCommand;
      now: Date;
      principal: FollowWritePrincipal;
      requestId: string;
    },
  ): Promise<FollowWriteOutcome> {
    const target = await this.#resolveTarget(
      transaction,
      input.principal.actorId,
      input.input,
    );
    const existing = await this.#findFollow(transaction, input.principal.actorId, target);
    let changed = false;
    let followId: string | null = existing?.id ?? null;
    let updatedAt = input.now;
    let notificationLevel: FollowNotificationLevel | null = null;

    if (input.input.active) {
      notificationLevel = input.input.notificationLevelProvided
        ? input.input.notificationLevel
        : isNotificationLevel(existing?.notification_level)
          ? existing.notification_level
          : "feed_only";
      if (notificationLevel === null) {
        throw new Error("An active Follow command requires an effective level.");
      }
      if (existing === null) {
        await this.#assertCardinalityAvailable(transaction, input.principal.actorId);
        followId = this.#newId("follow_id");
        const columns = this.#targetColumns(target);
        const inserted = await transaction<FollowRow[]>`
          insert into platform.follows (
            id,
            follower_actor_id,
            target_type,
            target_actor_id,
            target_symbol_id,
            target_topic_id,
            target_content_id,
            notification_level
          )
          values (
            ${followId},
            ${input.principal.actorId},
            ${target.targetType},
            ${columns.actorId},
            ${columns.symbolId},
            ${columns.topicId},
            ${columns.contentId},
            ${notificationLevel}
          )
          returning id::text as id, notification_level, created_at, updated_at
        `;
        const row = inserted[0];
        if (!row) throw new Error("The Follow insert returned no fact.");
        updatedAt = asDate(row.updated_at, "FOLLOW_DATA_INVALID");
        changed = true;
      } else if (existing.notification_level !== notificationLevel) {
        const updated = await transaction<FollowRow[]>`
          update platform.follows
          set notification_level = ${notificationLevel}
          where id = ${existing.id}
            and follower_actor_id = ${input.principal.actorId}
          returning id::text as id, notification_level, created_at, updated_at
        `;
        const row = updated[0];
        if (!row) throw new Error("The Follow update lost its locked fact.");
        updatedAt = asDate(row.updated_at, "FOLLOW_DATA_INVALID");
        changed = true;
      } else {
        updatedAt = asDate(existing.updated_at, "FOLLOW_DATA_INVALID");
      }
    } else if (existing !== null) {
      const deleted = await transaction<{ id: string }[]>`
        delete from platform.follows
        where id = ${existing.id}
          and follower_actor_id = ${input.principal.actorId}
        returning id::text as id
      `;
      if (deleted.length !== 1) {
        throw new Error("The Follow delete lost its locked fact.");
      }
      followId = existing.id;
      changed = true;
    }

    const outcome: FollowWriteOutcome = {
      decision: "allow",
      error: null,
      operation: "set_follow",
      pendingAction: null,
      replayed: false,
      result: {
        active: input.input.active,
        notificationLevel,
        targetId: target.targetId,
        targetType: target.targetType,
        updatedAt,
      },
      status: "succeeded",
    };
    const { id: outboxId } = await appendOutboxEvent(transaction, {
      aggregateId: `${input.principal.actorId}:${target.targetType}:${target.resourceId}`,
      aggregateType: "follow",
      eventType: changed ? "follow.changed" : "follow.confirmed",
      eventVersion: 1,
      occurredAt: input.now,
      payload: {
        active: input.input.active,
        changed,
        follow_id: followId,
        follower_actor_id: input.principal.actorId,
        notification_level: notificationLevel,
        target_id: target.targetId,
        target_resource_id: target.resourceId,
        target_type: target.targetType,
      },
    });
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decision: "allow",
      decisionId: input.decisionId,
      errorCode: null,
      now: input.now,
      outcome: "succeeded",
      outboxId,
      principal: input.principal,
      requestId: input.requestId,
      state: {
        active: input.input.active,
        changed,
        follow_id: followId,
        notification_level: notificationLevel,
        rate_rule_version: FOLLOW_RATE_RULE_VERSION,
        target_type: target.targetType,
      },
      targetId: target.targetId,
      targetType: target.targetType,
    });
    await this.#finalizeIdempotency(
      transaction,
      input.idempotencyId,
      "succeeded",
      200,
      outcome,
      target.resourceId,
    );
    return outcome;
  }

  #targetColumns(target: ResolvedTarget): {
    actorId: string | null;
    contentId: string | null;
    symbolId: string | null;
    topicId: string | null;
  } {
    return {
      actorId: target.targetType === "actor" ? target.resourceId : null,
      contentId: target.targetType === "content" ? target.resourceId : null,
      symbolId: target.targetType === "symbol" ? target.resourceId : null,
      topicId: target.targetType === "topic" ? target.resourceId : null,
    };
  }

  async #commitFailure(
    transaction: TransactionSql,
    input: {
      channel: string;
      decisionId: string;
      idempotencyId: string;
      input: NormalizedSetFollowCommand;
      now: Date;
      outcome: FollowWriteOutcome;
      principal: FollowWritePrincipal;
      rateRuleApplied: boolean;
      requestId: string;
    },
  ): Promise<void> {
    const error = input.outcome.error;
    if (error === null) throw new Error("A failed Follow outcome requires an error.");
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decision: input.outcome.decision,
      decisionId: input.decisionId,
      errorCode: error.code,
      now: input.now,
      outcome: input.outcome.status === "denied" ? "denied" : "failed",
      outboxId: null,
      principal: input.principal,
      requestId: input.requestId,
      state: {
        active: input.input.active,
        error_code: error.code,
        ...(input.rateRuleApplied ? { rate_rule_version: FOLLOW_RATE_RULE_VERSION } : {}),
        notification_level: input.input.notificationLevel,
        target_type: input.input.targetType,
      },
      targetId: input.input.targetId,
      targetType: input.input.targetType,
    });
    await this.#finalizeIdempotency(
      transaction,
      input.idempotencyId,
      input.outcome.status === "denied" ? "denied" : "failed",
      statusForError(error.code),
      input.outcome,
      null,
    );
  }

  async #commitTransientRateLimit(
    transaction: TransactionSql,
    input: {
      channel: string;
      decisionId: string;
      input: NormalizedSetFollowCommand;
      now: Date;
      outcome: FollowWriteOutcome;
      principal: FollowWritePrincipal;
      requestId: string;
    },
  ): Promise<void> {
    const error = input.outcome.error;
    if (
      input.outcome.decision !== "deny" ||
      input.outcome.status !== "denied" ||
      error?.code !== "RATE_LIMITED"
    ) {
      throw new Error("A transient Follow denial requires RATE_LIMITED.");
    }
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decision: "deny",
      decisionId: input.decisionId,
      errorCode: error.code,
      now: input.now,
      outcome: "denied",
      outboxId: null,
      principal: input.principal,
      requestId: input.requestId,
      state: {
        active: input.input.active,
        error_code: error.code,
        rate_rule_version: FOLLOW_RATE_RULE_VERSION,
        retry_after_ms: error.retryAfterMs,
        target_type: input.input.targetType,
      },
      targetId: input.input.targetId,
      targetType: input.input.targetType,
    });
  }

  async #writeActionLog(
    transaction: TransactionSql,
    event: {
      channel: string;
      decision: FollowWriteDecision;
      decisionId: string;
      errorCode: FollowErrorCode | null;
      now: Date;
      outcome: "succeeded" | "denied" | "failed";
      outboxId: string | null;
      principal: FollowWritePrincipal;
      requestId: string;
      state: postgres.JSONValue;
      targetId: string;
      targetType: FollowTargetType;
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
        outbox_event_id,
        policy_version,
        request_id,
        after_state,
        reason_code
      )
      values (
        ${this.#newId("audit_id")},
        'domain_write',
        ${event.now},
        ${event.principal.actorId},
        ${event.principal.actorKind},
        ${event.principal.ownerId},
        ${event.principal.agentId},
        ${event.principal.credentialId},
        ${event.channel},
        ${
          event.principal.credentialId === null
            ? event.principal.approvalMethod
            : event.decision === "allow"
              ? "policy_auto"
              : null
        },
        ${event.principal.credentialId === null ? event.principal.ownerId : null},
        ${event.principal.authenticationAssurance},
        ${transaction.json(event.principal.authorizationSnapshot(event.decisionId))},
        'follow.set',
        ${event.targetType},
        ${event.targetId},
        ${event.decision},
        ${event.outcome},
        ${event.errorCode},
        ${event.outboxId},
        ${event.principal.policyVersion},
        ${event.requestId},
        ${transaction.json(event.state)},
        ${(event.errorCode ?? event.principal.evaluation.reason).toLocaleLowerCase(
          "en-US",
        )}
      )
    `;
  }

  async #finalizeIdempotency(
    transaction: TransactionSql,
    id: string,
    status: "succeeded" | "denied" | "failed",
    responseCode: number,
    outcome: FollowWriteOutcome,
    resourceId: string | null,
  ): Promise<void> {
    const updated = await transaction<{ id: string }[]>`
      update platform.idempotency_records
      set status = ${status},
          response_code = ${responseCode},
          response_body = ${transaction.json(
            serializeOutcome(outcome, resourceId) as unknown as postgres.JSONValue,
          )},
          resource_id = ${resourceId},
          terminal_at = greatest(
            first_received_at,
            database_time.value
          ),
          expires_at = greatest(
            expires_at,
            greatest(first_received_at, database_time.value)
              + ${IDEMPOTENCY_MIN_RETENTION_MS} * interval '1 millisecond'
          ),
          updated_at = greatest(first_received_at, database_time.value)
      from (
        select clock_timestamp() as value
      ) as database_time
      where id = ${id}
        and status = 'in_progress'
        and terminal_at is null
      returning id::text as id
    `;
    if (updated.length !== 1) {
      throw new Error("The Follow idempotency result was not finalized exactly once.");
    }
  }
}
