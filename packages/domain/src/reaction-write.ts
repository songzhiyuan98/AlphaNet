import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

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
  CONTENT_REACTIONS_MIGRATION_CHECKSUM,
  FOLLOW_GRAPH_MIGRATION_CHECKSUM,
  PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM,
} from "./schema-migrations.js";
import {
  evaluateOwnerDirectOperation,
  type WebSocialAuthority,
  type WebSocialAuthorityResolver,
  type WebSocialAuthoritySelection,
} from "./web-social-authority.js";

const CONTENT_REACTIONS_MIGRATION_NAME = "content_reactions";
const CONTENT_REACTIONS_MIGRATION_VERSION = "000009";
const FOLLOW_GRAPH_MIGRATION_NAME = "follow_graph";
const FOLLOW_GRAPH_MIGRATION_VERSION = "000011";
const IDEMPOTENCY_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ESTABLISHED_AGENT_REACTIONS_PER_HOUR = 120;
const NEW_AGENT_REACTIONS_PER_HOUR = 60;
const NEW_AGENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const REACTION_RATE_WINDOW_MS = 60 * 60 * 1_000;
const REACTION_RATE_RULE_VERSION = "reaction-rate-v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REACTION_TYPES = ["helpful", "agree", "disagree"] as const;
const REACTION_ERROR_CODES = [
  "AUTHORIZATION_CONTEXT_STALE",
  "COMMUNITY_RESTRICTED",
  "CONTENT_NOT_FOUND",
  "CONTENT_STATE_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_RESULT_CORRUPT",
  "PLATFORM_WRITE_PAUSED",
  "POLICY_DENIED",
  "RATE_LIMITED",
  "SCOPE_REQUIRED",
  "SELF_REACTION_NOT_ALLOWED",
  "VALIDATION_ERROR",
] as const;

type TransactionSql = postgres.TransactionSql;

export type ReactionType = (typeof REACTION_TYPES)[number];
export type ReactionWriteDecision = "allow" | "require_approval" | "deny";
export type ReactionWriteStatus = "succeeded" | "denied" | "failed";
export type ReactionWriteErrorCode =
  | "AUTHORIZATION_CONTEXT_STALE"
  | "COMMUNITY_RESTRICTED"
  | "CONTENT_NOT_FOUND"
  | "CONTENT_STATE_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_RESULT_CORRUPT"
  | "PLATFORM_WRITE_PAUSED"
  | "POLICY_DENIED"
  | "RATE_LIMITED"
  | "SCOPE_REQUIRED"
  | "SELF_REACTION_NOT_ALLOWED"
  | "VALIDATION_ERROR";

export interface ReactionCounts {
  agree: number;
  disagree: number;
  helpful: number;
}

export interface ReactionViewerState {
  following: boolean;
  reactions: ReactionType[];
}

export interface SetReactionInput {
  active: boolean;
  contentId: string;
  idempotencyKey: string;
  reaction: ReactionType;
}

export interface ReactionWriteRequestContext {
  channel?: string | undefined;
  requestId: string;
}

export interface SetReactionResult {
  contentId: string;
  reactionCounts: ReactionCounts;
  viewerState: ReactionViewerState;
}

export interface ReactionWriteErrorDetail {
  code: ReactionWriteErrorCode;
  details: Record<string, string | number | boolean | null> | null;
  message: string;
  retryAfterMs: number | null;
  retryable: boolean;
}

export interface ReactionWriteOutcome {
  decision: ReactionWriteDecision;
  error: ReactionWriteErrorDetail | null;
  operation: "set_reaction";
  pendingAction: null;
  replayed: boolean;
  result: SetReactionResult | null;
  status: ReactionWriteStatus;
}

export interface ReactionWriteService {
  checkReady(): Promise<void>;
  setReaction(
    context: AgentCredentialContext,
    input: SetReactionInput,
    request: ReactionWriteRequestContext,
  ): Promise<ReactionWriteOutcome>;
}

export interface OwnerWebReactionWriteService {
  setReactionAsOwnerWeb(
    context: OwnerWebMutationContext,
    selection: WebSocialAuthoritySelection,
    input: SetReactionInput,
  ): Promise<ReactionWriteOutcome>;
}

export interface PostgresReactionWriteOptions {
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  idempotencyRetentionMs?: number | undefined;
  webSocialAuthorityResolver?: WebSocialAuthorityResolver | undefined;
}

export class ReactionWriteError extends Error {
  readonly code: ReactionWriteErrorCode;
  readonly details: Record<string, string | number | boolean | null> | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: ReactionWriteErrorCode,
    message: string,
    options: {
      details?: Record<string, string | number | boolean | null> | null | undefined;
      retryAfterMs?: number | null | undefined;
      retryable?: boolean | undefined;
      statusCode?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "ReactionWriteError";
    this.code = code;
    this.details = options.details ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? statusForError(code);
  }

  toDetail(): ReactionWriteErrorDetail {
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
  policy_schema_version: number;
  policy_tier: AgentPolicyTier;
  policy_version: string;
  policy_rules: unknown;
}

interface ContentTargetRow {
  author_actor_id: string;
  distribution_state: string;
  lifecycle_state: string;
  root_distribution_state: string;
  root_lifecycle_state: string;
  root_primary_community_id: string;
}

interface CommunityTargetRow {
  deleted_at: Date | null;
  status: string;
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

interface ReactionAggregateRow {
  active_reactions: string[];
  agree_count: number;
  disagree_count: number;
  following: boolean;
  helpful_count: number;
}

interface ReactionRateRow {
  reaction_count: number;
  retry_at: Date | null;
}

interface ReactionWritePrincipal {
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

interface PersistedReactionOutcome {
  decision: ReactionWriteDecision;
  error: null | {
    code: ReactionWriteErrorCode;
    details: Record<string, string | number | boolean | null> | null;
    message: string;
    retry_after_ms: number | null;
    retryable: boolean;
  };
  operation: "set_reaction";
  pending_action: null;
  result: null | {
    content_id: string;
    reaction_counts: ReactionCounts;
    viewer_state: {
      following: boolean;
      reactions: ReactionType[];
    };
  };
  status: ReactionWriteStatus;
  version: 1;
}

function statusForError(code: ReactionWriteErrorCode): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_RESTRICTED":
      return 403;
    case "CONTENT_NOT_FOUND":
      return 404;
    case "CONTENT_STATE_INVALID":
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "SELF_REACTION_NOT_ALLOWED":
      return 409;
    case "POLICY_DENIED":
    case "SCOPE_REQUIRED":
      return 403;
    case "RATE_LIMITED":
      return 429;
    case "PLATFORM_WRITE_PAUSED":
      return 503;
    case "VALIDATION_ERROR":
      return 422;
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

function isReactionType(value: unknown): value is ReactionType {
  return typeof value === "string" && REACTION_TYPES.includes(value as ReactionType);
}

function isReactionErrorCode(value: unknown): value is ReactionWriteErrorCode {
  return (
    typeof value === "string" &&
    REACTION_ERROR_CODES.includes(value as ReactionWriteErrorCode)
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

function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new ReactionWriteError(
      "VALIDATION_ERROR",
      `${field} must be a valid opaque UUID identifier.`,
      { details: { field } },
    );
  }
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
    throw new ReactionWriteError(
      "AUTHORIZATION_CONTEXT_STALE",
      "The authenticated Agent authority context is no longer valid.",
    );
  }
}

function validateIdempotencyKey(value: string): void {
  if (
    [...value].length < 1 ||
    [...value].length > 200 ||
    value.trim().length === 0 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ReactionWriteError(
      "VALIDATION_ERROR",
      "The idempotency key must be non-blank, control-free, and at most 200 characters.",
      { details: { field: "idempotency_key" } },
    );
  }
}

function validateRequestContext(request: ReactionWriteRequestContext): string {
  if (
    request.requestId.trim().length === 0 ||
    request.requestId.length > 200 ||
    /\p{Cc}/u.test(request.requestId)
  ) {
    throw new ReactionWriteError("VALIDATION_ERROR", "The request ID is invalid.", {
      details: { field: "request_id" },
    });
  }
  const channel = request.channel ?? "rest";
  if (!/^[a-z][a-z0-9_.-]{0,59}$/u.test(channel)) {
    throw new ReactionWriteError("VALIDATION_ERROR", "The request channel is invalid.", {
      details: { field: "channel" },
    });
  }
  return channel;
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function digestInput(input: SetReactionInput): Buffer {
  return createHash("sha256")
    .update(
      JSON.stringify({
        active: input.active,
        content_id: input.contentId,
        operation: "set_reaction",
        reaction: input.reaction,
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
    policy_id: authorization.policy_id,
    policy_schema_version: authorization.policy_schema_version,
    policy_tier: authorization.policy_tier,
    policy_version: authorization.policy_version,
    owner_policy_decision: evaluation.ownerPolicyDecision,
    policy_rule_source: evaluation.policyRuleSource,
    reason: evaluation.reason,
    required_scopes: [...evaluation.requiredScopes],
    scope_satisfied: evaluation.scopeSatisfied,
  };
}

function agentReactionPrincipal(
  context: AgentCredentialContext,
  authorization: AuthorizationRow,
  evaluation: AgentOperationEvaluation,
): ReactionWritePrincipal {
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

function ownerWebReactionPrincipal(
  authority: WebSocialAuthority,
): ReactionWritePrincipal {
  if (authority.kind === "human_direct") {
    const evaluation = humanDirectReactionEvaluation();
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

  const direct = evaluateOwnerDirectOperation(authority, "set_reaction");
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

function humanDirectReactionEvaluation(): AgentOperationEvaluation {
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

function normalizeReactionInput(input: SetReactionInput): SetReactionInput {
  assertUuid(input.contentId, "content_id");
  if (!REACTION_TYPES.includes(input.reaction)) {
    throw new ReactionWriteError(
      "VALIDATION_ERROR",
      "The reaction must be helpful, agree, or disagree.",
      { details: { field: "reaction" } },
    );
  }
  if (typeof input.active !== "boolean") {
    throw new ReactionWriteError(
      "VALIDATION_ERROR",
      "The active target state must be a boolean.",
      { details: { field: "active" } },
    );
  }
  validateIdempotencyKey(input.idempotencyKey);
  return {
    ...input,
    contentId: input.contentId.toLocaleLowerCase("en-US"),
  };
}

function errorOutcome(
  evaluation: AgentOperationEvaluation,
  error: ReactionWriteError,
): ReactionWriteOutcome {
  if (error.code === "RATE_LIMITED") {
    return rateLimitedOutcome(error);
  }
  if (error.code === "COMMUNITY_RESTRICTED") {
    return {
      decision: "deny",
      error: error.toDetail(),
      operation: "set_reaction",
      pendingAction: null,
      replayed: false,
      result: null,
      status: "denied",
    };
  }
  return {
    decision: evaluation.decision,
    error: error.toDetail(),
    operation: "set_reaction",
    pendingAction: null,
    replayed: false,
    result: null,
    status: evaluation.decision === "deny" ? "denied" : "failed",
  };
}

function rateLimitedOutcome(error: ReactionWriteError): ReactionWriteOutcome {
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
    operation: "set_reaction",
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function serializeOutcome(outcome: ReactionWriteOutcome): PersistedReactionOutcome {
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
    operation: "set_reaction",
    pending_action: null,
    result:
      outcome.result === null
        ? null
        : {
            content_id: outcome.result.contentId,
            reaction_counts: outcome.result.reactionCounts,
            viewer_state: outcome.result.viewerState,
          },
    status: outcome.status,
    version: 1,
  };
}

function parseCounts(value: unknown): ReactionCounts | null {
  if (!isRecord(value) || !hasExactKeys(value, ["agree", "disagree", "helpful"])) {
    return null;
  }
  const helpful = value.helpful;
  const agree = value.agree;
  const disagree = value.disagree;
  return Number.isInteger(helpful) &&
    Number(helpful) >= 0 &&
    Number.isInteger(agree) &&
    Number(agree) >= 0 &&
    Number.isInteger(disagree) &&
    Number(disagree) >= 0
    ? {
        agree: Number(agree),
        disagree: Number(disagree),
        helpful: Number(helpful),
      }
    : null;
}

function parsePersistedOutcome(
  value: unknown,
  expected: {
    contentId: string;
    resourceId: string | null;
    responseCode: number | null;
    status: IdempotencyRow["status"];
  },
): ReactionWriteOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "decision",
      "error",
      "operation",
      "pending_action",
      "result",
      "status",
      "version",
    ]) ||
    value.version !== 1 ||
    value.operation !== "set_reaction" ||
    value.pending_action !== null ||
    (value.decision !== "allow" && value.decision !== "deny") ||
    (value.status !== "succeeded" &&
      value.status !== "denied" &&
      value.status !== "failed")
  ) {
    throw new ReactionWriteError(
      "IDEMPOTENCY_RESULT_CORRUPT",
      "The stored reaction result is unavailable.",
      { retryable: true },
    );
  }

  let result: SetReactionResult | null = null;
  if (value.result !== null) {
    if (!isRecord(value.result)) {
      throw new ReactionWriteError(
        "IDEMPOTENCY_RESULT_CORRUPT",
        "The stored reaction result is unavailable.",
        { retryable: true },
      );
    }
    const counts = parseCounts(value.result.reaction_counts);
    const viewer = value.result.viewer_state;
    if (
      !hasExactKeys(value.result, ["content_id", "reaction_counts", "viewer_state"]) ||
      typeof value.result.content_id !== "string" ||
      !isUuid(value.result.content_id) ||
      counts === null ||
      !isRecord(viewer) ||
      !hasExactKeys(viewer, ["following", "reactions"]) ||
      typeof viewer.following !== "boolean" ||
      !Array.isArray(viewer.reactions) ||
      !viewer.reactions.every(isReactionType) ||
      new Set(viewer.reactions).size !== viewer.reactions.length
    ) {
      throw new ReactionWriteError(
        "IDEMPOTENCY_RESULT_CORRUPT",
        "The stored reaction result is unavailable.",
        { retryable: true },
      );
    }
    result = {
      contentId: value.result.content_id,
      reactionCounts: counts,
      viewerState: {
        following: viewer.following,
        reactions: [...viewer.reactions] as ReactionType[],
      },
    };
  }

  let error: ReactionWriteErrorDetail | null = null;
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
      !isReactionErrorCode(value.error.code) ||
      typeof value.error.message !== "string" ||
      value.error.message.length < 1 ||
      value.error.message.length > 2_000 ||
      typeof value.error.retryable !== "boolean" ||
      (value.error.retry_after_ms !== null &&
        (!Number.isSafeInteger(value.error.retry_after_ms) ||
          Number(value.error.retry_after_ms) <= 0)) ||
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
      throw new ReactionWriteError(
        "IDEMPOTENCY_RESULT_CORRUPT",
        "The stored reaction result is unavailable.",
        { retryable: true },
      );
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
    (value.status === "succeeded" &&
      (expected.responseCode !== 200 ||
        expected.resourceId !== expected.contentId ||
        result?.contentId !== expected.contentId)) ||
    (value.status !== "succeeded" &&
      (error === null ||
        expected.responseCode !== statusForError(error.code) ||
        expected.resourceId !== null))
  ) {
    throw new ReactionWriteError(
      "IDEMPOTENCY_RESULT_CORRUPT",
      "The stored reaction result is unavailable.",
      { retryable: true },
    );
  }

  return {
    decision: value.decision,
    error,
    operation: "set_reaction",
    pendingAction: null,
    replayed: true,
    result,
    status: value.status,
  };
}

export class PostgresReactionWriteService
  implements ReactionWriteService, OwnerWebReactionWriteService
{
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #idempotencyRetentionMs: number;
  readonly #sql: PostgresClient;
  readonly #webSocialAuthorityResolver: WebSocialAuthorityResolver | null;

  constructor(sql: PostgresClient, options: PostgresReactionWriteOptions = {}) {
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#idempotencyRetentionMs =
      options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    this.#webSocialAuthorityResolver = options.webSocialAuthorityResolver ?? null;
    if (
      !Number.isSafeInteger(this.#idempotencyRetentionMs) ||
      this.#idempotencyRetentionMs < IDEMPOTENCY_MIN_RETENTION_MS
    ) {
      throw new RangeError("Reaction idempotency retention must be at least 7 days.");
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
            where version = ${CONTENT_REACTIONS_MIGRATION_VERSION}
              and name = ${CONTENT_REACTIONS_MIGRATION_NAME}
              and checksum = ${CONTENT_REACTIONS_MIGRATION_CHECKSUM}
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
            where version = ${FOLLOW_GRAPH_MIGRATION_VERSION}
              and name = ${FOLLOW_GRAPH_MIGRATION_NAME}
              and checksum = ${FOLLOW_GRAPH_MIGRATION_CHECKSUM}
          )
          and exists (
            select 1
            from system.schema_migrations
            where version = '000026'
              and checksum =
                ${PLATFORM_EMERGENCY_WRITE_CONTROL_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.community_write_controls') is not null
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.credentials')
              and attname = 'policy_ceiling_rules'
              and attnotnull
              and not attisdropped
          )
          and to_regclass('platform.reactions') is not null
          and to_regclass('platform.follows') is not null
          and to_regclass('platform.reactions_content_type_created_idx') is not null
          and to_regclass('platform.reactions_actor_created_idx') is not null
          and to_regclass(
            'platform.action_logs_reaction_succeeded_agent_occurred_idx'
          ) is not null
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.reactions')
              and tgname = 'reactions_validate_insert'
              and tgfoid = to_regprocedure('platform.validate_reaction_insert()')
              and tgtype = 7
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.reactions')
              and tgname = 'reactions_prevent_update'
              and tgfoid = to_regprocedure('platform.prevent_reaction_update()')
              and tgtype = 19
              and not tgisinternal
              and tgenabled in ('O', 'A')
          ) as ready
      `;
    });
    if (rows.length !== 1 || rows[0]?.ready !== true) {
      throw new Error("Reaction write schema is not ready.");
    }
  }

  async setReaction(
    context: AgentCredentialContext,
    input: SetReactionInput,
    request: ReactionWriteRequestContext,
  ): Promise<ReactionWriteOutcome> {
    validateAuthorityContext(context);
    const preliminary = evaluateAgentOperation({
      credentialPolicyCeiling: context.credential.policyCeiling,
      credentialPolicyCeilingDefaultsVersion:
        context.credential.policyCeilingDefaultsVersion,
      credentialPolicyCeilingRules: context.credential.policyCeilingRules,
      credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
      operation: "set_reaction",
      policyDefaultsVersion: context.agent.policy.defaultsVersion,
      policyRules: context.agent.policy.rules,
      policySchemaVersion: context.agent.policy.schemaVersion,
      policyTier: context.agent.policy.tier,
      scopes: context.credential.scopes,
    });
    if (!preliminary.scopeSatisfied) {
      throw new ReactionWriteError(
        "SCOPE_REQUIRED",
        "The Agent credential lacks the reaction:write scope.",
      );
    }

    let currentEvaluation = preliminary;
    try {
      const command = normalizeReactionInput(input);
      const channel = validateRequestContext(request);
      const digest = digestInput(command);

      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const authorization = await this.#loadAuthorization(transaction, context);
        currentEvaluation = evaluateAgentOperation({
          credentialPolicyCeiling: authorization.credential_policy_ceiling,
          credentialPolicyCeilingDefaultsVersion:
            authorization.credential_policy_ceiling_defaults_version,
          credentialPolicyCeilingRules: authorization.credential_policy_ceiling_rules,
          credentialPolicyCeilingSchemaVersion:
            authorization.credential_policy_ceiling_schema_version,
          operation: "set_reaction",
          policyDefaultsVersion: authorization.defaults_version,
          policyRules: authorization.policy_rules,
          policySchemaVersion: authorization.policy_schema_version,
          policyTier: authorization.policy_tier,
          scopes: authorization.credential_scopes,
        });
        if (!currentEvaluation.scopeSatisfied) {
          throw new ReactionWriteError(
            "SCOPE_REQUIRED",
            "The Agent credential lacks the reaction:write scope.",
          );
        }
        const principal = agentReactionPrincipal(
          context,
          authorization,
          currentEvaluation,
        );
        return this.#executeReaction(transaction, {
          channel,
          command,
          digest,
          principal,
          requestId: request.requestId,
        });
      });
    } catch (error) {
      if (error instanceof ReactionWriteError) {
        return errorOutcome(currentEvaluation, error);
      }
      throw error;
    }
  }

  async setReactionAsOwnerWeb(
    context: OwnerWebMutationContext,
    selection: WebSocialAuthoritySelection,
    input: SetReactionInput,
  ): Promise<ReactionWriteOutcome> {
    const resolver = this.#webSocialAuthorityResolver;
    if (!resolver) {
      throw new Error("The Owner Web social authority resolver is unavailable.");
    }
    let currentEvaluation = humanDirectReactionEvaluation();
    try {
      const command = normalizeReactionInput(input);
      const digest = digestInput(command);
      return await this.#sql.begin(async (transaction) => {
        await transaction`set local statement_timeout = '10s'`;
        const authority = await resolver.resolveAuthorityInTransaction(
          transaction,
          context,
          selection,
        );
        const principal = ownerWebReactionPrincipal(authority);
        currentEvaluation = principal.evaluation;
        return this.#executeReaction(transaction, {
          channel: "web",
          command,
          digest,
          principal,
          requestId: context.requestId,
        });
      });
    } catch (error) {
      if (error instanceof ReactionWriteError) {
        return errorOutcome(currentEvaluation, error);
      }
      throw error;
    }
  }

  async #executeReaction(
    transaction: TransactionSql,
    input: {
      channel: string;
      command: SetReactionInput;
      digest: Buffer;
      principal: ReactionWritePrincipal;
      requestId: string;
    },
  ): Promise<ReactionWriteOutcome> {
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
        throw new ReactionWriteError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used with different normalized input.",
        );
      }
      if (existing.status === "admission_reserved" || existing.status === "in_progress") {
        throw new ReactionWriteError(
          "IDEMPOTENCY_IN_PROGRESS",
          "The original reaction write is still in progress.",
          { retryable: true },
        );
      }
      return parsePersistedOutcome(existing.response_body, {
        contentId: command.contentId,
        resourceId: existing.resource_id,
        responseCode: existing.response_code,
        status: existing.status,
      });
    }

    const writeControl = await readCommunityWriteControl(transaction);
    if (writeControl.mode === "paused") {
      throw new ReactionWriteError(
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
      throw new Error("The reaction write clock returned an invalid Date.");
    }
    const decisionId = this.#newId("decision_id");

    if (principal.evaluation.decision === "deny") {
      const idempotencyId = this.#newId("idempotency_record_id");
      await this.#insertIdempotency(transaction, {
        digest: input.digest,
        id: idempotencyId,
        idempotencyKey: command.idempotencyKey,
        principal,
      });
      const denied = errorOutcome(
        principal.evaluation,
        new ReactionWriteError(
          "POLICY_DENIED",
          "The selected Agent policy does not permit reactions.",
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
      await this.#enforceReactionRate(transaction, principal, now);
    } catch (error) {
      if (error instanceof ReactionWriteError && error.code === "RATE_LIMITED") {
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
        "reaction_write_admission",
        async (admissionTransaction) =>
          this.#commitReaction(admissionTransaction, {
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
      if (error instanceof ReactionWriteError) {
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
      throw new ReactionWriteError(
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
      throw new ReactionWriteError(
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
          ${`alphanet:idempotency:${principalScopeKey}:set_reaction:${idempotencyKey}`},
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
        and operation = 'set_reaction'
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
      principal: ReactionWritePrincipal;
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
        'set_reaction',
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

  async #loadTarget(
    transaction: TransactionSql,
    contentId: string,
  ): Promise<ContentTargetRow> {
    const rows = await transaction<ContentTargetRow[]>`
      select
        content.author_actor_id::text as author_actor_id,
        content.lifecycle_state,
        content.distribution_state,
        root.lifecycle_state as root_lifecycle_state,
        root.distribution_state as root_distribution_state,
        root.primary_community_id::text as root_primary_community_id
      from platform.content_items as content
      join platform.content_items as root on root.id = content.root_id
      where content.id = ${contentId}
      limit 1
      for update of content
      for share of root
    `;
    const row = rows[0];
    if (
      !row ||
      row.distribution_state === "hidden" ||
      row.root_distribution_state === "hidden"
    ) {
      throw new ReactionWriteError(
        "CONTENT_NOT_FOUND",
        "The requested content is not available.",
      );
    }
    if (row.lifecycle_state !== "published" || row.root_lifecycle_state !== "published") {
      throw new ReactionWriteError(
        "CONTENT_STATE_INVALID",
        "Reactions require published content in a published discussion.",
      );
    }
    const communities = await transaction<CommunityTargetRow[]>`
      select
        community.status,
        community.deleted_at
      from platform.communities as community
      where community.id = ${row.root_primary_community_id}
      for share of community
    `;
    if (communities.length !== 1 || communities[0]?.deleted_at !== null) {
      throw new ReactionWriteError(
        "CONTENT_NOT_FOUND",
        "The requested content is not available.",
      );
    }
    if (communities[0].status !== "active") {
      throw new ReactionWriteError(
        "COMMUNITY_RESTRICTED",
        "The primary Community is not accepting social writes.",
        { details: { community_state: communities[0].status } },
      );
    }
    return row;
  }

  async #enforceReactionRate(
    transaction: TransactionSql,
    principal: ReactionWritePrincipal,
    now: Date,
  ): Promise<void> {
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`alphanet:reaction-rate:${principal.actorId}`},
          0
        )
      )
    `;
    const windowStart = new Date(now.valueOf() - REACTION_RATE_WINDOW_MS);
    // Do not cap this scan at the caller clock. A request that waited for the
    // per-Agent lock must still count writes committed by a later-clocked
    // request that acquired the lock first; future-skewed rows fail closed.
    const rows = await transaction<ReactionRateRow[]>`
      select
        count(*)::integer as reaction_count,
        min(action.occurred_at) + interval '1 hour' as retry_at
      from platform.action_logs as action
      where action.actor_id = ${principal.actorId}
        and action.action = 'reaction.set'
        and action.outcome = 'succeeded'
        and action.occurred_at >= ${windowStart}
    `;
    const row = rows[0];
    if (!row || !Number.isInteger(row.reaction_count) || row.reaction_count < 0) {
      throw new Error("Reaction quota projection returned invalid data.");
    }
    const isNewAgent =
      now.valueOf() - principal.activatedAt.valueOf() < NEW_AGENT_WINDOW_MS;
    const limit = isNewAgent
      ? NEW_AGENT_REACTIONS_PER_HOUR
      : ESTABLISHED_AGENT_REACTIONS_PER_HOUR;
    if (row.reaction_count >= limit) {
      const retryAt = row.retry_at?.valueOf() ?? now.valueOf() + REACTION_RATE_WINDOW_MS;
      const retryAfterMs = Math.max(1, retryAt - now.valueOf());
      throw new ReactionWriteError(
        "RATE_LIMITED",
        "The Actor reaction limit for this rolling hour has been reached.",
        {
          details: {
            limit,
            limit_dimension:
              principal.actorKind === "agent"
                ? "agent_reaction_hour"
                : "human_reaction_hour",
            new_agent_window: isNewAgent,
            rule_version: REACTION_RATE_RULE_VERSION,
          },
          retryAfterMs,
          retryable: true,
        },
      );
    }
  }

  async #commitReaction(
    transaction: TransactionSql,
    input: {
      channel: string;
      decisionId: string;
      idempotencyId: string;
      input: SetReactionInput;
      now: Date;
      principal: ReactionWritePrincipal;
      requestId: string;
    },
  ): Promise<ReactionWriteOutcome> {
    const target = await this.#loadTarget(transaction, input.input.contentId);
    if (input.input.active && target.author_actor_id === input.principal.actorId) {
      throw new ReactionWriteError(
        "SELF_REACTION_NOT_ALLOWED",
        "Actors cannot react to their own content.",
      );
    }

    let changed: boolean;
    if (input.input.active) {
      const inserted = await transaction<{ actor_id: string }[]>`
        insert into platform.reactions (
          actor_id,
          content_id,
          reaction_type,
          created_at
        )
        values (
          ${input.principal.actorId},
          ${input.input.contentId},
          ${input.input.reaction},
          ${input.now}
        )
        on conflict (actor_id, content_id, reaction_type) do nothing
        returning actor_id::text as actor_id
      `;
      changed = inserted.length === 1;
    } else {
      const deleted = await transaction<{ actor_id: string }[]>`
        delete from platform.reactions
        where actor_id = ${input.principal.actorId}
          and content_id = ${input.input.contentId}
          and reaction_type = ${input.input.reaction}
        returning actor_id::text as actor_id
      `;
      changed = deleted.length === 1;
    }

    const aggregate = await this.#reactionAggregate(
      transaction,
      input.principal.actorId,
      input.input.contentId,
    );
    const outcome: ReactionWriteOutcome = {
      decision: "allow",
      error: null,
      operation: "set_reaction",
      pendingAction: null,
      replayed: false,
      result: {
        contentId: input.input.contentId,
        reactionCounts: {
          agree: aggregate.agree_count,
          disagree: aggregate.disagree_count,
          helpful: aggregate.helpful_count,
        },
        viewerState: {
          following: aggregate.following,
          reactions: aggregate.active_reactions as ReactionType[],
        },
      },
      status: "succeeded",
    };

    const { id: outboxId } = await appendOutboxEvent(transaction, {
      aggregateId: input.input.contentId,
      aggregateType: "content",
      eventType: changed ? "reaction.changed" : "reaction.confirmed",
      eventVersion: 1,
      occurredAt: input.now,
      payload: {
        active: input.input.active,
        actor_id: input.principal.actorId,
        changed,
        content_id: input.input.contentId,
        reaction: input.input.reaction,
      },
    });
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decisionId: input.decisionId,
      errorCode: null,
      decision: "allow",
      outcome: "succeeded",
      outboxId,
      principal: input.principal,
      state: {
        active: input.input.active,
        active_reactions: aggregate.active_reactions,
        changed,
        rate_rule_version: REACTION_RATE_RULE_VERSION,
        reaction: input.input.reaction,
      },
      targetId: input.input.contentId,
      now: input.now,
      requestId: input.requestId,
    });
    await this.#finalizeIdempotency(
      transaction,
      input.idempotencyId,
      "succeeded",
      200,
      outcome,
      input.input.contentId,
    );
    return outcome;
  }

  async #reactionAggregate(
    transaction: TransactionSql,
    actorId: string,
    contentId: string,
  ): Promise<ReactionAggregateRow> {
    const rows = await transaction<ReactionAggregateRow[]>`
      select
        coalesce(
          array_agg(reaction.reaction_type order by
            case reaction.reaction_type
              when 'helpful' then 1
              when 'agree' then 2
              when 'disagree' then 3
            end
          ) filter (where reaction.actor_id = ${actorId}),
          array[]::text[]
        ) as active_reactions,
        count(*) filter (where reaction.reaction_type = 'helpful')::integer
          as helpful_count,
        count(*) filter (where reaction.reaction_type = 'agree')::integer
          as agree_count,
        count(*) filter (where reaction.reaction_type = 'disagree')::integer
          as disagree_count,
        exists (
          select 1
          from platform.follows as follow
          where follow.follower_actor_id = ${actorId}
            and follow.target_type = 'content'
            and follow.target_content_id = ${contentId}
        ) as following
      from platform.reactions as reaction
      where reaction.content_id = ${contentId}
    `;
    const row = rows[0];
    if (
      !row ||
      !Array.isArray(row.active_reactions) ||
      !row.active_reactions.every(isReactionType) ||
      !Number.isInteger(row.helpful_count) ||
      !Number.isInteger(row.agree_count) ||
      !Number.isInteger(row.disagree_count) ||
      typeof row.following !== "boolean" ||
      row.helpful_count < 0 ||
      row.agree_count < 0 ||
      row.disagree_count < 0
    ) {
      throw new Error("Reaction aggregate returned invalid data.");
    }
    return row;
  }

  async #commitFailure(
    transaction: TransactionSql,
    input: {
      channel: string;
      decisionId: string;
      idempotencyId: string;
      input: SetReactionInput;
      now: Date;
      outcome: ReactionWriteOutcome;
      principal: ReactionWritePrincipal;
      rateRuleApplied: boolean;
      requestId: string;
    },
  ): Promise<void> {
    const error = input.outcome.error;
    if (error === null) {
      throw new Error("A failed reaction outcome requires an error.");
    }
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decisionId: input.decisionId,
      errorCode: error.code,
      decision: input.outcome.decision,
      outcome: input.outcome.status === "denied" ? "denied" : "failed",
      outboxId: null,
      principal: input.principal,
      state: {
        active: input.input.active,
        error_code: error.code,
        ...(input.rateRuleApplied
          ? { rate_rule_version: REACTION_RATE_RULE_VERSION }
          : {}),
        reaction: input.input.reaction,
      },
      targetId: input.input.contentId,
      now: input.now,
      requestId: input.requestId,
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
      input: SetReactionInput;
      now: Date;
      outcome: ReactionWriteOutcome;
      principal: ReactionWritePrincipal;
      requestId: string;
    },
  ): Promise<void> {
    const error = input.outcome.error;
    if (
      input.outcome.decision !== "deny" ||
      input.outcome.status !== "denied" ||
      error?.code !== "RATE_LIMITED"
    ) {
      throw new Error("A transient reaction denial requires RATE_LIMITED.");
    }
    await this.#writeActionLog(transaction, {
      channel: input.channel,
      decision: "deny",
      decisionId: input.decisionId,
      errorCode: error.code,
      outcome: "denied",
      outboxId: null,
      principal: input.principal,
      state: {
        active: input.input.active,
        error_code: error.code,
        rate_rule_version: REACTION_RATE_RULE_VERSION,
        reaction: input.input.reaction,
        retry_after_ms: error.retryAfterMs,
      },
      targetId: input.input.contentId,
      now: input.now,
      requestId: input.requestId,
    });
  }

  async #writeActionLog(
    transaction: TransactionSql,
    event: {
      channel: string;
      decision: ReactionWriteDecision;
      decisionId: string;
      errorCode: ReactionWriteErrorCode | null;
      now: Date;
      outcome: "succeeded" | "denied" | "failed";
      outboxId: string | null;
      principal: ReactionWritePrincipal;
      requestId: string;
      state: postgres.JSONValue;
      targetId: string;
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
        'reaction.set',
        'content',
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
    outcome: ReactionWriteOutcome,
    resourceId: string | null,
  ): Promise<void> {
    const updated = await transaction<{ id: string }[]>`
      update platform.idempotency_records
      set status = ${status},
          response_code = ${responseCode},
          response_body = ${transaction.json(
            serializeOutcome(outcome) as unknown as postgres.JSONValue,
          )},
          resource_id = ${resourceId},
          terminal_at = greatest(first_received_at, database_time.value),
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
      throw new Error("The reaction idempotency result was not finalized exactly once.");
    }
  }
}
