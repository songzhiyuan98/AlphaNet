import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { evaluateAgentOperation, type AgentOperationEvaluation } from "./agent-policy.js";
import type {
  AgentCredentialContext,
  AgentPolicyTier,
  AgentScope,
} from "./agent-connection.js";
import {
  catalogSymbolCommunitySlug,
  COMMUNITY_RESEARCH_MIGRATION_CHECKSUM,
} from "./community-directory.js";
import {
  encryptPendingCommand,
  type PendingCommandKeyRing,
} from "./pending-command-codec.js";
import {
  digestResearchCommand,
  digestResearchCommandBytes,
  normalizeCreatePostCommand,
  normalizeReplyCommand,
  ResearchCommandValidationError,
  type CreatePostCommandInput,
  type NormalizedResearchCommand,
  type ReplyCommandInput,
} from "./research-command.js";

const BODY_BYTES_LIMIT = 160 * 1_024;
const COMMAND_BYTES_LIMIT = 1_024 * 1_024;
const DEFAULT_ACTIVE_PENDING_ACTIONS_PER_AGENT = 20;
const DEFAULT_PROTECTED_ACTION_INTENTS_PER_HOUR = 20;
const IDEMPOTENCY_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PUBLIC_NODE_BYTES = 768 * 1_024;
const SOURCE_METADATA_BYTES_LIMIT = 128 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_POSTING_RULES: CommunityPostingRules = {
  allowedContent: [
    "investment-research",
    "source-analysis",
    "question",
    "discussion",
    "trade-review",
  ],
  maxPostsPerHour: 6,
  repliesOpen: true,
  requiresSources: false,
};

type TransactionSql = postgres.TransactionSql;

export type ResearchWriteDecision = "allow" | "require_approval" | "deny";
export type ResearchWriteStatus = "succeeded" | "pending_approval" | "denied" | "failed";
export type ResearchWriteOperation = "create_post" | "reply_to_content";

export type ResearchWriteErrorCode =
  | "AUTHORIZATION_CONTEXT_STALE"
  | "COMMUNITY_NOT_FOUND"
  | "COMMUNITY_RESTRICTED"
  | "CONTENT_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_RESULT_CORRUPT"
  | "POLICY_DENIED"
  | "RATE_LIMITED"
  | "REPLIES_CLOSED"
  | "SCOPE_REQUIRED"
  | "VALIDATION_ERROR";

export interface ResearchWriteErrorDetail {
  code: ResearchWriteErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, string | number | boolean | null> | null;
  retryAfterMs: number | null;
}

export class ResearchWriteError extends Error {
  readonly code: ResearchWriteErrorCode;
  readonly details: Record<string, string | number | boolean | null> | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: ResearchWriteErrorCode,
    message: string,
    options: {
      details?: Record<string, string | number | boolean | null> | null | undefined;
      retryAfterMs?: number | null | undefined;
      retryable?: boolean | undefined;
      statusCode?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "ResearchWriteError";
    this.code = code;
    this.details = options.details ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? statusForError(code);
  }

  toDetail(): ResearchWriteErrorDetail {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export interface CreatePostResearchWriteInput extends CreatePostCommandInput {
  idempotencyKey: string;
}

export interface ReplyResearchWriteInput extends ReplyCommandInput {
  idempotencyKey: string;
}

export interface ResearchWriteRequestContext {
  channel?: string | undefined;
  requestId: string;
}

export interface CreatePostResearchResult {
  contentId: string;
  resourceVersion: number;
  revisionId: string;
}

export interface ReplyResearchResult extends CreatePostResearchResult {
  rootContentId: string;
}

export interface ResearchPendingActionSummary {
  approvalSummary: string;
  decisionId: string;
  expiresAt: Date;
  id: string;
  inputDigest: string;
  operation: ResearchWriteOperation;
  policyVersion: string;
  requestedAt: Date;
  state: "pending_approval";
}

export interface ResearchWriteOutcome {
  decision: ResearchWriteDecision;
  error: ResearchWriteErrorDetail | null;
  operation: ResearchWriteOperation;
  pendingAction: ResearchPendingActionSummary | null;
  replayed: boolean;
  result: CreatePostResearchResult | ReplyResearchResult | null;
  status: ResearchWriteStatus;
}

export interface ResearchWriteService {
  checkReady(): Promise<void>;
  createPost(
    context: AgentCredentialContext,
    input: CreatePostResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome>;
  replyToContent(
    context: AgentCredentialContext,
    input: ReplyResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome>;
}

export interface PostgresResearchWriteOptions {
  activePendingActionsPerAgent?: number | undefined;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  idempotencyRetentionMs?: number | undefined;
  pendingActionKeyRing: PendingCommandKeyRing;
  pendingActionTtlMs?: number | undefined;
  protectedActionIntentsPerHour?: number | undefined;
}

interface AuthorizationRow {
  actor_id: string;
  credential_policy_ceiling: AgentPolicyTier;
  credential_scopes: AgentScope[];
  defaults_version: string;
  policy_id: string;
  policy_schema_version: number;
  policy_tier: AgentPolicyTier;
  policy_version: string;
}

interface IdempotencyRow {
  id: string;
  request_digest: Buffer;
  response_body: unknown;
  status:
    | "admission_reserved"
    | "in_progress"
    | "pending_approval"
    | "succeeded"
    | "denied"
    | "failed";
}

interface CommunityRow {
  canonical_symbol_id: string | null;
  id: string;
  kind: "symbol" | "topic" | "general";
  posting_rules: unknown;
  state: "active" | "read_only" | "suspended" | "archived";
}

interface CatalogSymbolRow {
  community_candidate_id: string;
  exchange: string;
  id: string;
  name: string;
  ticker: string;
}

interface CommunityPostingRules {
  allowedContent: string[];
  maxPostsPerHour: number;
  repliesOpen: boolean;
  requiresSources: boolean;
}

interface CommunityAdmission {
  catalogSymbol: CatalogSymbolRow | null;
  canonicalSymbolId: string | null;
  id: string;
  kind: "symbol" | "topic" | "general";
  materialization: "materialized" | "catalog_only";
  rules: CommunityPostingRules;
  state: "active" | "read_only" | "suspended" | "archived";
}

interface ParentRow {
  depth: number;
  parent_distribution_state: string;
  parent_lifecycle_state: string;
  primary_community_id: string;
  root_distribution_state: string;
  root_id: string;
  root_lifecycle_state: string;
}

interface ReplyTarget {
  communityIds: string[];
  depth: number;
  parentContentId: string;
  rootContentId: string;
}

interface ClassificationRow {
  id: string;
  value: string;
}

interface MentionRow {
  actor_id: string;
  handle: string;
}

interface ResolvedWriteFacts {
  mentionActorIds: string[];
  referenceTargetIds: Set<string>;
  symbolIds: string[];
  topicIds: string[];
}

interface PreparedRevision {
  bodyPlainText: string;
  contentHash: Buffer;
  publicNodeBytes: number;
}

interface ProtectedActionIntentWindow {
  active_pending_count: number;
  active_retry_at: Date | null;
  hourly_intent_count: number;
  hourly_retry_at: Date | null;
}

interface PersistedOutcome {
  decision: ResearchWriteDecision;
  error: ResearchWriteErrorDetail | null;
  operation: ResearchWriteOperation;
  pending_action: null | {
    approval_summary: string;
    decision_id: string;
    expires_at: string;
    id: string;
    input_digest: string;
    operation: ResearchWriteOperation;
    policy_version: string;
    requested_at: string;
    state: "pending_approval";
  };
  result: null | {
    content_id: string;
    resource_version: number;
    revision_id: string;
    root_content_id?: string | undefined;
  };
  status: ResearchWriteStatus;
  version: 1;
}

interface ResearchWriteDispatchState {
  evaluation: AgentOperationEvaluation;
}

function statusForError(code: ResearchWriteErrorCode): number {
  switch (code) {
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_NOT_FOUND":
    case "CONTENT_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
      return 409;
    case "COMMUNITY_RESTRICTED":
    case "POLICY_DENIED":
    case "REPLIES_CLOSED":
    case "SCOPE_REQUIRED":
      return 403;
    case "RATE_LIMITED":
      return 429;
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

function unicodeLength(value: string): number {
  return [...value].length;
}

function assertUuid(value: string, field: string): void {
  if (!isUuid(value)) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      `${field} must be a valid opaque UUID identifier.`,
      { details: { field } },
    );
  }
}

function validateIdempotencyKey(value: string): void {
  if (
    unicodeLength(value) < 1 ||
    unicodeLength(value) > 200 ||
    value.trim().length === 0 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The idempotency key must be non-blank, control-free, and at most 200 characters.",
      { details: { field: "idempotency_key" } },
    );
  }
}

function validateRequestContext(request: ResearchWriteRequestContext): string {
  if (
    request.requestId.trim().length === 0 ||
    request.requestId.length > 200 ||
    /\p{Cc}/u.test(request.requestId)
  ) {
    throw new ResearchWriteError("VALIDATION_ERROR", "The request ID is invalid.", {
      details: { field: "request_id" },
    });
  }
  const channel = request.channel ?? "rest";
  if (!/^[a-z][a-z0-9_.-]{0,59}$/.test(channel)) {
    throw new ResearchWriteError("VALIDATION_ERROR", "The request channel is invalid.", {
      details: { field: "channel" },
    });
  }
  return channel;
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
    throw new ResearchWriteError(
      "AUTHORIZATION_CONTEXT_STALE",
      "The authenticated Agent authority context is no longer valid.",
    );
  }
}

function validateCommandBudgets(command: NormalizedResearchCommand): void {
  const isPost = command.operation === "create_post";
  const titleLength = isPost ? unicodeLength(command.title) : 0;
  const bodyLength = unicodeLength(command.bodyMarkdown);
  const bodyBytes = Buffer.byteLength(command.bodyMarkdown, "utf8");

  if (isPost && (titleLength < 5 || titleLength > 200)) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "Post titles must contain 5 through 200 Unicode characters.",
      { details: { field: "title" } },
    );
  }
  if (
    command.bodyMarkdown.trim().length === 0 ||
    bodyLength > (isPost ? 100_000 : 20_000) ||
    bodyBytes > BODY_BYTES_LIMIT
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The normalized Markdown body is outside the operation limits.",
      { details: { field: "body_markdown" } },
    );
  }
  if (
    command.symbols.length > 10 ||
    command.topics.length > 5 ||
    command.sourceLinks.length > 50 ||
    command.references.length > 20 ||
    (isPost && command.additionalCommunityIds.length > 4)
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The command exceeds a collection-size limit.",
    );
  }

  for (const source of command.sourceLinks) {
    if (
      Buffer.byteLength(source.url, "utf8") > 2_048 ||
      (source.title !== undefined && unicodeLength(source.title) > 300) ||
      (source.description !== undefined && unicodeLength(source.description) > 1_000)
    ) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "Source metadata exceeds its field limits.",
        { details: { field: "source_links" } },
      );
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(command.sourceLinks), "utf8") >
    SOURCE_METADATA_BYTES_LIMIT
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "Source metadata exceeds the serialized 128 KiB limit.",
      { details: { field: "source_links" } },
    );
  }
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > COMMAND_BYTES_LIMIT) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The normalized command exceeds the 1 MiB write limit.",
    );
  }

  if (isPost) {
    assertUuid(command.primaryCommunityId, "primary_community_id");
    for (const id of command.additionalCommunityIds) {
      assertUuid(id, "additional_community_ids");
    }
  } else {
    assertUuid(command.parentContentId, "parent_content_id");
  }
  for (const reference of command.references) {
    assertUuid(reference.targetContentId, "references.target_content_id");
  }
}

function parsePostingRules(value: unknown): CommunityPostingRules {
  if (!isRecord(value)) {
    throw new Error("Community posting rules failed their database invariant.");
  }
  const allowed = value.allowed_content;
  const maxPosts = value.max_posts_per_hour;
  if (
    !Array.isArray(allowed) ||
    !allowed.every((item): item is string => typeof item === "string") ||
    typeof maxPosts !== "number" ||
    !Number.isInteger(maxPosts) ||
    typeof value.requires_sources !== "boolean" ||
    typeof value.replies_open !== "boolean"
  ) {
    throw new Error("Community posting rules failed their database invariant.");
  }
  return {
    allowedContent: allowed,
    maxPostsPerHour: maxPosts,
    repliesOpen: value.replies_open,
    requiresSources: value.requires_sources,
  };
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function policySnapshot(
  authorization: AuthorizationRow,
  evaluation: AgentOperationEvaluation,
  decisionId: string,
): postgres.JSONValue {
  return {
    decision: evaluation.decision,
    decision_id: decisionId,
    defaults_version: authorization.defaults_version,
    matched_scope: evaluation.matchedScope,
    policy_id: authorization.policy_id,
    policy_schema_version: authorization.policy_schema_version,
    policy_tier: authorization.policy_tier,
    policy_version: authorization.policy_version,
    reason: evaluation.reason,
    required_scopes: [...evaluation.requiredScopes],
    scope_satisfied: evaluation.scopeSatisfied,
  };
}

function errorOutcome(
  operation: ResearchWriteOperation,
  evaluation: AgentOperationEvaluation,
): ResearchWriteOutcome {
  const error = new ResearchWriteError(
    "POLICY_DENIED",
    "The Agent policy does not permit this operation.",
    { details: { reason: evaluation.reason } },
  );
  return {
    decision: "deny",
    error: error.toDetail(),
    operation,
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function rateLimitedOutcome(
  operation: ResearchWriteOperation,
  error: ResearchWriteError,
): ResearchWriteOutcome {
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
    operation,
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function isPlatformRuleDenial(error: ResearchWriteError): boolean {
  return error.code === "COMMUNITY_RESTRICTED" || error.code === "REPLIES_CLOSED";
}

function platformRuleDeniedOutcome(
  operation: ResearchWriteOperation,
  error: ResearchWriteError,
): ResearchWriteOutcome {
  if (!isPlatformRuleDenial(error)) {
    throw new Error("A platform-rule denial requires a stable hard-rule error.");
  }
  return {
    decision: "deny",
    error: error.toDetail(),
    operation,
    pendingAction: null,
    replayed: false,
    result: null,
    status: "denied",
  };
}

function expectedErrorOutcome(
  operation: ResearchWriteOperation,
  evaluation: AgentOperationEvaluation,
  error: ResearchWriteError,
): ResearchWriteOutcome {
  if (error.code === "AUTHORIZATION_CONTEXT_STALE" || error.code === "SCOPE_REQUIRED") {
    throw error;
  }
  if (error.code === "RATE_LIMITED") {
    return rateLimitedOutcome(operation, error);
  }
  if (isPlatformRuleDenial(error)) {
    throw new Error(
      "A platform-rule denial escaped its stable idempotency and audit boundary.",
      { cause: error },
    );
  }

  // `deny/failed` is deliberately not a valid public state: deny is reserved
  // for an authoritative policy or platform-rule refusal. An error discovered
  // while dispatching a write therefore retains the executable decision class.
  // A tightened read-only policy can only reach this branch while checking an
  // older idempotency record before the fresh policy denial; use `allow/failed`
  // so the idempotency failure remains observable without misreporting it as a
  // new policy denial.
  const decision =
    evaluation.decision === "require_approval" ? "require_approval" : "allow";
  return {
    decision,
    error: error.toDetail(),
    operation,
    pendingAction: null,
    replayed: false,
    result: null,
    status: "failed",
  };
}

function normalizeCommandError(
  error: ResearchCommandValidationError,
): ResearchWriteError {
  return new ResearchWriteError("VALIDATION_ERROR", error.message, {
    details: { reason_code: error.code },
  });
}

function serializeOutcome(outcome: ResearchWriteOutcome): PersistedOutcome {
  return {
    version: 1,
    operation: outcome.operation,
    decision: outcome.decision,
    status: outcome.status,
    result:
      outcome.result === null
        ? null
        : {
            content_id: outcome.result.contentId,
            revision_id: outcome.result.revisionId,
            resource_version: outcome.result.resourceVersion,
            ...("rootContentId" in outcome.result
              ? { root_content_id: outcome.result.rootContentId }
              : {}),
          },
    pending_action:
      outcome.pendingAction === null
        ? null
        : {
            id: outcome.pendingAction.id,
            operation: outcome.pendingAction.operation,
            state: outcome.pendingAction.state,
            expires_at: outcome.pendingAction.expiresAt.toISOString(),
            input_digest: outcome.pendingAction.inputDigest,
            requested_at: outcome.pendingAction.requestedAt.toISOString(),
            decision_id: outcome.pendingAction.decisionId,
            policy_version: outcome.pendingAction.policyVersion,
            approval_summary: outcome.pendingAction.approvalSummary,
          },
    error: outcome.error,
  };
}

function parseErrorDetail(value: unknown): ResearchWriteErrorDetail | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    !(value.details === null || isRecord(value.details)) ||
    !(value.retryAfterMs === null || typeof value.retryAfterMs === "number")
  ) {
    throw corruptIdempotencyResult();
  }
  return value as unknown as ResearchWriteErrorDetail;
}

function parsePersistedOutcome(
  value: unknown,
  expectedOperation: ResearchWriteOperation,
): ResearchWriteOutcome {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.operation !== expectedOperation ||
    (value.decision !== "allow" &&
      value.decision !== "require_approval" &&
      value.decision !== "deny") ||
    (value.status !== "succeeded" &&
      value.status !== "pending_approval" &&
      value.status !== "denied" &&
      value.status !== "failed")
  ) {
    throw corruptIdempotencyResult();
  }
  const operation = expectedOperation;

  let result: CreatePostResearchResult | ReplyResearchResult | null = null;
  if (value.result !== null) {
    if (
      !isRecord(value.result) ||
      typeof value.result.content_id !== "string" ||
      typeof value.result.revision_id !== "string" ||
      typeof value.result.resource_version !== "number"
    ) {
      throw corruptIdempotencyResult();
    }
    result =
      operation === "reply_to_content"
        ? typeof value.result.root_content_id === "string"
          ? {
              contentId: value.result.content_id,
              revisionId: value.result.revision_id,
              resourceVersion: value.result.resource_version,
              rootContentId: value.result.root_content_id,
            }
          : null
        : {
            contentId: value.result.content_id,
            revisionId: value.result.revision_id,
            resourceVersion: value.result.resource_version,
          };
    if (result === null) throw corruptIdempotencyResult();
  }

  let pendingAction: ResearchPendingActionSummary | null = null;
  if (value.pending_action !== null) {
    const pending = value.pending_action;
    if (
      !isRecord(pending) ||
      typeof pending.id !== "string" ||
      pending.operation !== operation ||
      pending.state !== "pending_approval" ||
      typeof pending.expires_at !== "string" ||
      typeof pending.input_digest !== "string" ||
      typeof pending.requested_at !== "string" ||
      typeof pending.decision_id !== "string" ||
      typeof pending.policy_version !== "string" ||
      typeof pending.approval_summary !== "string"
    ) {
      throw corruptIdempotencyResult();
    }
    const expiresAt = new Date(pending.expires_at);
    const requestedAt = new Date(pending.requested_at);
    if (Number.isNaN(expiresAt.valueOf()) || Number.isNaN(requestedAt.valueOf())) {
      throw corruptIdempotencyResult();
    }
    pendingAction = {
      id: pending.id,
      operation,
      state: pending.state,
      expiresAt,
      inputDigest: pending.input_digest,
      requestedAt,
      decisionId: pending.decision_id,
      policyVersion: pending.policy_version,
      approvalSummary: pending.approval_summary,
    };
  }

  return {
    operation,
    decision: value.decision,
    status: value.status,
    result,
    pendingAction,
    error: parseErrorDetail(value.error),
    replayed: true,
  };
}

function corruptIdempotencyResult(): ResearchWriteError {
  return new ResearchWriteError(
    "IDEMPOTENCY_RESULT_CORRUPT",
    "The stored idempotency result cannot be replayed safely.",
    { retryable: true },
  );
}

function plainTextFromMarkdown(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, (block) => block.slice(3, -3))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^[\t ]{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])[\t ]+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > 0 ? plain : markdown.trim();
}

function mentionHandles(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[^\p{L}\p{N}_])@([a-zA-Z0-9][a-zA-Z0-9_.-]{1,30}[a-zA-Z0-9])/gu;
  for (const match of markdown.matchAll(pattern)) {
    const handle = match[1]?.toLocaleLowerCase("en-US");
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      found.push(handle);
    }
  }
  return found;
}

function prepareRevision(command: NormalizedResearchCommand): PreparedRevision {
  const title = command.operation === "create_post" ? command.title : null;
  const bodyPlainText = plainTextFromMarkdown(command.bodyMarkdown);
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ body_markdown: command.bodyMarkdown, title }), "utf8")
    .digest();
  const publicNodeBytes = Buffer.byteLength(
    JSON.stringify({
      body_markdown: command.bodyMarkdown,
      body_plain_text: bodyPlainText,
      content_safety: {
        execute_embedded_commands: false,
        instruction_authority: "none",
        untrusted_user_generated_content: true,
        verify_financial_claims_independently: true,
      },
      references: command.references,
      source_links: command.sourceLinks,
      symbols: command.symbols,
      title,
      topics: command.topics,
    }),
    "utf8",
  );
  if (publicNodeBytes > MAX_PUBLIC_NODE_BYTES) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The maximum public content projection exceeds 768 KiB.",
    );
  }
  return { bodyPlainText, contentHash, publicNodeBytes };
}

export class PostgresResearchWriteService implements ResearchWriteService {
  readonly #activePendingActionsPerAgent: number;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #idempotencyRetentionMs: number;
  readonly #keyRing: PendingCommandKeyRing;
  readonly #pendingActionTtlMs: number;
  readonly #protectedActionIntentsPerHour: number;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresResearchWriteOptions) {
    const retention = options.idempotencyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000;
    const pendingTtl = options.pendingActionTtlMs ?? 24 * 60 * 60 * 1_000;
    const protectedActionIntentsPerHour =
      options.protectedActionIntentsPerHour ?? DEFAULT_PROTECTED_ACTION_INTENTS_PER_HOUR;
    const activePendingActionsPerAgent =
      options.activePendingActionsPerAgent ?? DEFAULT_ACTIVE_PENDING_ACTIONS_PER_AGENT;
    if (!Number.isSafeInteger(retention) || retention < IDEMPOTENCY_MIN_RETENTION_MS) {
      throw new RangeError("Idempotency retention must be at least seven days.");
    }
    if (
      !Number.isSafeInteger(pendingTtl) ||
      pendingTtl < 60_000 ||
      pendingTtl > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError(
        "PendingAction TTL must be from one minute through seven days.",
      );
    }
    if (!options.pendingActionKeyRing) {
      throw new TypeError("A PendingAction encryption key ring is required.");
    }
    if (
      !Number.isSafeInteger(protectedActionIntentsPerHour) ||
      protectedActionIntentsPerHour < 1 ||
      protectedActionIntentsPerHour > 10_000
    ) {
      throw new RangeError(
        "Protected-action intent limit must be from one through ten thousand per hour.",
      );
    }
    if (
      !Number.isSafeInteger(activePendingActionsPerAgent) ||
      activePendingActionsPerAgent < 1 ||
      activePendingActionsPerAgent > 10_000
    ) {
      throw new RangeError(
        "Active PendingAction limit must be from one through ten thousand per Agent.",
      );
    }
    this.#activePendingActionsPerAgent = activePendingActionsPerAgent;
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#idempotencyRetentionMs = retention;
    this.#pendingActionTtlMs = pendingTtl;
    this.#protectedActionIntentsPerHour = protectedActionIntentsPerHour;
    this.#keyRing = options.pendingActionKeyRing;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000006'
              and name = 'community_research_core'
              and checksum = ${COMMUNITY_RESEARCH_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.content_items') is not null
          and to_regclass('platform.content_revisions') is not null
          and to_regclass('platform.idempotency_records') is not null
          and to_regclass('platform.pending_actions') is not null
          and to_regclass('platform.source_links_current_url_unique') is not null
          and to_regclass('platform.content_relations_current_unique') is not null
          and to_regclass('platform.pending_actions_worker_idx') is not null
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.symbols')
              and attname = 'community_candidate_id'
              and not attisdropped
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.content_revisions')
              and tgname = 'content_revisions_prevent_mutation'
              and not tgisinternal
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new Error("Research write schema is not ready");
    }
  }

  async createPost(
    context: AgentCredentialContext,
    input: CreatePostResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome> {
    return this.#dispatch(
      context,
      "create_post",
      () => normalizeCreatePostCommand(input),
      input.idempotencyKey,
      request,
    );
  }

  async replyToContent(
    context: AgentCredentialContext,
    input: ReplyResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome> {
    return this.#dispatch(
      context,
      "reply_to_content",
      () => normalizeReplyCommand(input),
      input.idempotencyKey,
      request,
    );
  }

  async #dispatch(
    context: AgentCredentialContext,
    operation: ResearchWriteOperation,
    normalize: () => NormalizedResearchCommand,
    idempotencyKey: string,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome> {
    validateAuthorityContext(context);
    const preliminary = evaluateAgentOperation({
      credentialPolicyCeiling: context.credential.policyCeiling,
      operation,
      policyTier: context.agent.policy.tier,
      scopes: context.credential.scopes,
    });
    if (!preliminary.scopeSatisfied) {
      throw new ResearchWriteError(
        "SCOPE_REQUIRED",
        "The Agent credential lacks the content:write scope.",
      );
    }

    const dispatchState: ResearchWriteDispatchState = { evaluation: preliminary };
    try {
      const command = normalize();
      return await this.#write(context, command, idempotencyKey, request, dispatchState);
    } catch (caught) {
      const error =
        caught instanceof ResearchCommandValidationError
          ? normalizeCommandError(caught)
          : caught;
      if (error instanceof ResearchWriteError) {
        return expectedErrorOutcome(operation, dispatchState.evaluation, error);
      }
      throw error;
    }
  }

  async #write(
    context: AgentCredentialContext,
    command: NormalizedResearchCommand,
    idempotencyKey: string,
    request: ResearchWriteRequestContext,
    dispatchState: ResearchWriteDispatchState,
  ): Promise<ResearchWriteOutcome> {
    validateIdempotencyKey(idempotencyKey);
    validateCommandBudgets(command);
    const channel = validateRequestContext(request);

    const digestBytes = digestResearchCommandBytes(command);
    const digestText = digestResearchCommand(command);
    const principalScopeKey = `credential:${context.credential.id}`;

    return this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '10s'`;
      const authorization = await this.#loadAuthorization(transaction, context);
      const evaluation = evaluateAgentOperation({
        credentialPolicyCeiling: authorization.credential_policy_ceiling,
        operation: command.operation,
        policyTier: authorization.policy_tier,
        scopes: authorization.credential_scopes,
      });
      dispatchState.evaluation = evaluation;
      if (!evaluation.scopeSatisfied) {
        // Scope failures remain outside the unified write/idempotency surface.
        throw new ResearchWriteError(
          "SCOPE_REQUIRED",
          "The Agent credential lacks the content:write scope.",
        );
      }

      await this.#lockIdempotency(
        transaction,
        principalScopeKey,
        command.operation,
        idempotencyKey,
      );
      const existing = await this.#findIdempotency(
        transaction,
        principalScopeKey,
        command.operation,
        idempotencyKey,
      );
      if (existing) {
        if (!sameDigest(existing.request_digest, digestBytes)) {
          throw new ResearchWriteError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used with different normalized input.",
          );
        }
        if (
          existing.status === "admission_reserved" ||
          existing.status === "in_progress"
        ) {
          throw new ResearchWriteError(
            "IDEMPOTENCY_IN_PROGRESS",
            "The original write is still in progress.",
            { retryable: true },
          );
        }
        return parsePersistedOutcome(existing.response_body, command.operation);
      }

      const now = new Date(this.#clock().valueOf());
      if (Number.isNaN(now.valueOf())) {
        throw new Error("The research write clock returned an invalid Date.");
      }
      const decisionId = this.#newId("decision_id");

      if (evaluation.decision === "deny") {
        const idempotencyId = this.#newId("idempotency_record_id");
        await this.#insertIdempotency(transaction, {
          actorId: authorization.actor_id,
          agentId: context.agent.id,
          credentialId: context.credential.id,
          digestBytes,
          id: idempotencyId,
          idempotencyKey,
          now,
          operation: command.operation,
          ownerId: context.owner.id,
          principalScopeKey,
        });
        const outcome = errorOutcome(command.operation, evaluation);
        await this.#writeActionLog(transaction, {
          action: actionName(command.operation),
          actorId: authorization.actor_id,
          after: { reason: evaluation.reason },
          agentId: context.agent.id,
          auditId: this.#newId("audit_id"),
          channel,
          credentialId: context.credential.id,
          decision: "deny",
          decisionId,
          errorCode: "POLICY_DENIED",
          evaluation,
          outcome: "denied",
          occurredAt: now,
          outboxId: null,
          ownerId: context.owner.id,
          policy: authorization,
          requestId: request.requestId,
          targetId: intendedTargetId(command),
          targetType: command.operation === "create_post" ? "community" : "content",
        });
        await this.#finalizeIdempotency(
          transaction,
          idempotencyId,
          "denied",
          403,
          outcome,
          null,
          now,
        );
        return outcome;
      }

      if (evaluation.decision === "require_approval") {
        await this.#enforceProtectedActionIntent(
          transaction,
          context.owner.id,
          context.agent.id,
          now,
        );
      }

      let replyTarget: ReplyTarget | null = null;
      try {
        replyTarget = await transaction.savepoint(
          "research_write_admission",
          async (admissionTransaction) => {
            if (command.operation === "create_post") {
              const targetIds = [
                command.primaryCommunityId,
                ...command.additionalCommunityIds,
              ];
              let admissions = await this.#inspectCommunities(
                admissionTransaction,
                targetIds,
              );

              // Enforce the synthesized catalog rules before any write, then
              // enforce the locked authoritative rows again after the upsert.
              // The savepoint lets a concurrent restrictive materialization
              // roll back every local admission effect before the outer
              // transaction records the stable denial.
              this.#enforceCommunityRules(
                admissions,
                "investment-research",
                command.sourceLinks.length > 0,
                false,
              );
              if (evaluation.decision === "allow") {
                await this.#materializeCatalogCommunities(
                  admissionTransaction,
                  admissions,
                );
                admissions = await this.#inspectCommunities(
                  admissionTransaction,
                  targetIds,
                );
                for (const inspected of admissions) {
                  if (inspected.materialization !== "materialized") {
                    throw new ResearchWriteError(
                      "COMMUNITY_NOT_FOUND",
                      "The catalog Community could not be materialized safely.",
                      { details: { community_id: inspected.id } },
                    );
                  }
                }
                this.#enforceCommunityRules(
                  admissions,
                  "investment-research",
                  command.sourceLinks.length > 0,
                  false,
                );
                await this.#enforcePostRates(
                  admissionTransaction,
                  authorization.actor_id,
                  admissions,
                  now,
                );
              }
              return null;
            }

            const inspectedReplyTarget = await this.#loadReplyTarget(
              admissionTransaction,
              command.parentContentId,
            );
            const admissions = await this.#inspectCommunities(
              admissionTransaction,
              inspectedReplyTarget.communityIds,
            );
            this.#enforceCommunityRules(
              admissions,
              "discussion",
              command.sourceLinks.length > 0,
              true,
            );
            return inspectedReplyTarget;
          },
        );
      } catch (error) {
        if (error instanceof ResearchWriteError && isPlatformRuleDenial(error)) {
          return this.#commitPlatformRuleDenial(transaction, {
            authorization,
            channel,
            command,
            context,
            decisionId,
            digestBytes,
            error,
            evaluation,
            idempotencyKey,
            now,
            principalScopeKey,
            requestId: request.requestId,
          });
        }
        throw error;
      }

      const facts = await this.#resolveWriteFacts(transaction, command);
      const preparedRevision = prepareRevision(command);
      const idempotencyId = this.#newId("idempotency_record_id");
      await this.#insertIdempotency(transaction, {
        actorId: authorization.actor_id,
        agentId: context.agent.id,
        credentialId: context.credential.id,
        digestBytes,
        id: idempotencyId,
        idempotencyKey,
        now,
        operation: command.operation,
        ownerId: context.owner.id,
        principalScopeKey,
      });

      if (evaluation.decision === "require_approval") {
        return this.#createPendingAction(transaction, {
          authorization,
          channel,
          command,
          context,
          decisionId,
          digestBytes,
          digestText,
          evaluation,
          idempotencyId,
          idempotencyKey,
          now,
          principalScopeKey,
          requestId: request.requestId,
        });
      }

      return this.#commitAutonomousContent(transaction, {
        authorization,
        channel,
        command,
        context,
        decisionId,
        evaluation,
        facts,
        idempotencyId,
        now,
        preparedRevision,
        replyTarget,
        requestId: request.requestId,
      });
    });
  }

  #newId(field: string): string {
    const id = this.#idFactory();
    if (!isUuid(id)) {
      throw new Error(`The configured ID factory returned an invalid ${field}.`);
    }
    return id;
  }

  async #loadAuthorization(
    transaction: TransactionSql,
    context: AgentCredentialContext,
  ): Promise<AuthorizationRow> {
    const owners = await transaction<{ id: string }[]>`
      select owner.id
      from platform.owners as owner
      where owner.id = ${context.owner.id}
      for share
    `;
    if (!owners[0]) {
      throw new ResearchWriteError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    const rows = await transaction<AuthorizationRow[]>`
      select
        actor.id as actor_id,
        credential.scopes as credential_scopes,
        credential.policy_ceiling as credential_policy_ceiling,
        policy.id as policy_id,
        policy.tier as policy_tier,
        policy.defaults_version,
        policy.policy_schema_version,
        policy.version::text as policy_version
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
        and (
          credential.expires_at is null
          or credential.expires_at > clock_timestamp()
        )
        and owner.status = 'active'
        and owner.email_verified_at is not null
        and owner.deleted_at is null
        and agent.status = 'active'
        and agent.deleted_at is null
        and actor.status = 'active'
        and actor.deleted_at is null
      limit 1
      for share of credential, agent, actor, policy
    `;
    const row = rows[0];
    if (!row) {
      throw new ResearchWriteError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    return row;
  }

  async #lockIdempotency(
    transaction: TransactionSql,
    principalScopeKey: string,
    operation: ResearchWriteOperation,
    idempotencyKey: string,
  ): Promise<void> {
    const lockKey = `alphanet:idempotency:${principalScopeKey}:${operation}:${idempotencyKey}`;
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(${lockKey}, 0)
      )
    `;
  }

  async #findIdempotency(
    transaction: TransactionSql,
    principalScopeKey: string,
    operation: ResearchWriteOperation,
    idempotencyKey: string,
  ): Promise<IdempotencyRow | null> {
    const rows = await transaction<IdempotencyRow[]>`
      select id, request_digest, status, response_body
      from platform.idempotency_records
      where principal_scope_key = ${principalScopeKey}
        and operation = ${operation}
        and idempotency_key = ${idempotencyKey}
      limit 1
      for update
    `;
    return rows[0] ?? null;
  }

  async #insertIdempotency(
    transaction: TransactionSql,
    input: {
      actorId: string;
      agentId: string;
      credentialId: string;
      digestBytes: Buffer;
      id: string;
      idempotencyKey: string;
      now: Date;
      operation: ResearchWriteOperation;
      ownerId: string;
      principalScopeKey: string;
    },
  ): Promise<void> {
    const expiresAt = new Date(input.now.valueOf() + this.#idempotencyRetentionMs);
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
        ${input.principalScopeKey},
        ${input.ownerId},
        ${input.agentId},
        ${input.actorId},
        ${input.credentialId},
        ${input.operation},
        ${input.idempotencyKey},
        ${input.digestBytes},
        'in_progress',
        ${input.now},
        ${input.now},
        ${expiresAt}
      )
    `;
  }

  async #commitPlatformRuleDenial(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      channel: string;
      command: NormalizedResearchCommand;
      context: AgentCredentialContext;
      decisionId: string;
      digestBytes: Buffer;
      error: ResearchWriteError;
      evaluation: AgentOperationEvaluation;
      idempotencyKey: string;
      now: Date;
      principalScopeKey: string;
      requestId: string;
    },
  ): Promise<ResearchWriteOutcome> {
    const idempotencyId = this.#newId("idempotency_record_id");
    await this.#insertIdempotency(transaction, {
      actorId: input.authorization.actor_id,
      agentId: input.context.agent.id,
      credentialId: input.context.credential.id,
      digestBytes: input.digestBytes,
      id: idempotencyId,
      idempotencyKey: input.idempotencyKey,
      now: input.now,
      operation: input.command.operation,
      ownerId: input.context.owner.id,
      principalScopeKey: input.principalScopeKey,
    });
    const outcome = platformRuleDeniedOutcome(input.command.operation, input.error);
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        error_code: input.error.code,
        ...(input.error.details ?? {}),
      },
      agentId: input.context.agent.id,
      auditId: this.#newId("audit_id"),
      channel: input.channel,
      credentialId: input.context.credential.id,
      decision: "deny",
      decisionId: input.decisionId,
      errorCode: input.error.code,
      evaluation: input.evaluation,
      outcome: "denied",
      occurredAt: input.now,
      outboxId: null,
      ownerId: input.context.owner.id,
      policy: input.authorization,
      reasonCode: input.error.code.toLocaleLowerCase("en-US"),
      requestId: input.requestId,
      targetId: intendedTargetId(input.command),
      targetType: input.command.operation === "create_post" ? "community" : "content",
    });
    await this.#finalizeIdempotency(
      transaction,
      idempotencyId,
      "denied",
      403,
      outcome,
      null,
      input.now,
    );
    return outcome;
  }

  async #inspectCommunities(
    transaction: TransactionSql,
    communityIds: readonly string[],
  ): Promise<CommunityAdmission[]> {
    const admissions: CommunityAdmission[] = [];
    for (const communityId of communityIds) {
      assertUuid(communityId, "community_id");
      const communities = await transaction<CommunityRow[]>`
        select
          community.id,
          community.kind,
          community.status as state,
          community.posting_rules,
          symbol_mapping.symbol_id as canonical_symbol_id
        from platform.communities as community
        left join platform.community_symbols as symbol_mapping
          on symbol_mapping.community_id = community.id
         and symbol_mapping.is_primary
        where community.id = ${communityId}
          and community.deleted_at is null
        limit 1
        for share of community
      `;
      const community = communities[0];
      if (community) {
        admissions.push({
          catalogSymbol: null,
          canonicalSymbolId: community.canonical_symbol_id,
          id: community.id,
          kind: community.kind,
          materialization: "materialized",
          rules: parsePostingRules(community.posting_rules),
          state: community.state,
        });
        continue;
      }

      const symbols = await transaction<CatalogSymbolRow[]>`
        select
          symbol.id,
          symbol.community_candidate_id,
          symbol.ticker::text as ticker,
          symbol.exchange,
          symbol.name
        from platform.symbols as symbol
        where symbol.community_candidate_id = ${communityId}
          and symbol.status = 'active'
        limit 1
        for share
      `;
      const symbol = symbols[0];
      if (!symbol) {
        throw new ResearchWriteError(
          "COMMUNITY_NOT_FOUND",
          "The requested Community does not exist.",
          { details: { community_id: communityId } },
        );
      }
      admissions.push({
        catalogSymbol: symbol,
        canonicalSymbolId: symbol.id,
        id: communityId,
        kind: "symbol",
        materialization: "catalog_only",
        rules: {
          ...DEFAULT_POSTING_RULES,
          allowedContent: [...DEFAULT_POSTING_RULES.allowedContent],
        },
        state: "active",
      });
    }
    return admissions;
  }

  async #materializeCatalogCommunities(
    transaction: TransactionSql,
    admissions: readonly CommunityAdmission[],
  ): Promise<void> {
    for (const admission of this.#orderedUniqueCommunities(admissions)) {
      const symbol = admission.catalogSymbol;
      if (admission.materialization !== "catalog_only" || !symbol) continue;
      const slug = catalogSymbolCommunitySlug(
        symbol.ticker,
        symbol.community_candidate_id,
      );
      await transaction`
        insert into platform.communities (
          id,
          slug,
          name,
          description,
          kind,
          status,
          settings
        )
        values (
          ${symbol.community_candidate_id},
          ${slug},
          ${`${symbol.ticker} Research`},
          ${`${symbol.name} (${symbol.ticker}, ${symbol.exchange}) market research.`},
          'symbol',
          'active',
          ${transaction.json({
            materialized_from: "symbol_catalog",
            symbol_id: symbol.id,
          })}
        )
        on conflict do nothing
      `;
      await transaction`
        insert into platform.community_symbols (
          community_id,
          symbol_id,
          is_primary
        )
        select community.id, symbol.id, true
        from platform.symbols as symbol
        join platform.communities as community
          on community.id = symbol.community_candidate_id
         and community.kind = 'symbol'
        where symbol.id = ${symbol.id}
          and symbol.community_candidate_id = ${symbol.community_candidate_id}
        on conflict do nothing
      `;
    }
  }

  #enforceCommunityRules(
    admissions: readonly CommunityAdmission[],
    requiredContentType: "investment-research" | "discussion",
    hasSources: boolean,
    isReply: boolean,
  ): void {
    for (const admission of admissions) {
      if (admission.state !== "active") {
        throw new ResearchWriteError(
          "COMMUNITY_RESTRICTED",
          "The requested Community is not accepting writes.",
          {
            details: {
              community_id: admission.id,
              community_state: admission.state,
            },
          },
        );
      }
      if (!admission.rules.allowedContent.includes(requiredContentType)) {
        throw new ResearchWriteError(
          "COMMUNITY_RESTRICTED",
          "The requested Community does not allow this content category.",
          {
            details: {
              community_id: admission.id,
              content_category: requiredContentType,
            },
          },
        );
      }
      if (admission.rules.requiresSources && !hasSources) {
        throw new ResearchWriteError(
          "VALIDATION_ERROR",
          "At least one source is required by the Community posting rules.",
          { details: { community_id: admission.id, field: "source_links" } },
        );
      }
      if (isReply && !admission.rules.repliesOpen) {
        throw new ResearchWriteError(
          "REPLIES_CLOSED",
          "Replies are closed for this discussion Community.",
          { details: { community_id: admission.id } },
        );
      }
      if (!isReply && admission.rules.maxPostsPerHour === 0) {
        throw new ResearchWriteError(
          "COMMUNITY_RESTRICTED",
          "The Community is not accepting new posts.",
          { details: { community_id: admission.id } },
        );
      }
    }
  }

  #orderedUniqueCommunities(
    admissions: readonly CommunityAdmission[],
  ): CommunityAdmission[] {
    const byCanonicalId = new Map<string, CommunityAdmission>();
    for (const admission of admissions) {
      const canonicalId = admission.id.toLocaleLowerCase("en-US");
      if (!byCanonicalId.has(canonicalId)) {
        byCanonicalId.set(canonicalId, admission);
      }
    }
    return [...byCanonicalId.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, admission]) => admission);
  }

  async #enforcePostRates(
    transaction: TransactionSql,
    actorId: string,
    admissions: readonly CommunityAdmission[],
    now: Date,
  ): Promise<void> {
    const orderedAdmissions = this.#orderedUniqueCommunities(admissions);

    // Acquire the complete lock set before reading any quota window. A stable
    // UUID order prevents opposite primary/additional target orders from
    // deadlocking while preserving one authoritative actor x Community gate.
    for (const admission of orderedAdmissions) {
      const communityId = admission.id.toLocaleLowerCase("en-US");
      const lockKey = `alphanet:community-post-rate:${actorId}:${communityId}`;
      await transaction`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${lockKey}, 0)
        )
      `;
    }

    for (const admission of orderedAdmissions) {
      const communityId = admission.id.toLocaleLowerCase("en-US");
      const rows = await transaction<{ admitted_count: number; retry_at: Date | null }[]>`
        with admitted as (
          select content.created_at as admitted_at
          from platform.content_items as content
          where content.author_actor_id = ${actorId}
            and content.kind = 'post'
            and (
              content.primary_community_id = ${communityId}
              or exists (
                select 1
                from platform.content_additional_communities as additional
                where additional.content_id = content.id
                  and additional.community_id = ${communityId}
              )
            )
            and content.created_at > ${now} - interval '1 hour'
        )
        select
          count(*)::integer as admitted_count,
          min(admitted_at) + interval '1 hour' as retry_at
        from admitted
      `;
      const window = rows[0];
      if (window && window.admitted_count >= admission.rules.maxPostsPerHour) {
        const retryAfterMs = Math.max(
          1,
          (window.retry_at?.valueOf() ?? now.valueOf() + 60_000) - now.valueOf(),
        );
        throw new ResearchWriteError(
          "RATE_LIMITED",
          "The Community post rate limit has been reached for this author.",
          {
            details: { community_id: communityId },
            retryable: true,
            retryAfterMs,
          },
        );
      }
    }
  }

  async #enforceProtectedActionIntent(
    transaction: TransactionSql,
    ownerId: string,
    agentId: string,
    now: Date,
  ): Promise<void> {
    const lockKey = `alphanet:protected-action-intent:${agentId}`;
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(${lockKey}, 0)
      )
    `;
    const rows = await transaction<ProtectedActionIntentWindow[]>`
      select
        count(*) filter (
          where requested_at > ${now} - interval '1 hour'
        )::integer as hourly_intent_count,
        min(requested_at) filter (
          where requested_at > ${now} - interval '1 hour'
        ) + interval '1 hour' as hourly_retry_at,
        count(*) filter (
          where state in ('pending_approval', 'approved', 'executing')
            and expires_at > ${now}
        )::integer as active_pending_count,
        min(expires_at) filter (
          where state in ('pending_approval', 'approved', 'executing')
            and expires_at > ${now}
        ) as active_retry_at
      from platform.pending_actions
      where owner_id = ${ownerId}
        and agent_id = ${agentId}
        and (
          requested_at > ${now} - interval '1 hour'
          or (
            state in ('pending_approval', 'approved', 'executing')
            and expires_at > ${now}
          )
        )
    `;
    const window = rows[0];
    if (!window) {
      throw new Error("Protected-action intent window query returned no aggregate row.");
    }
    if (window.hourly_intent_count >= this.#protectedActionIntentsPerHour) {
      const retryAfterMs = Math.max(
        1,
        (window.hourly_retry_at?.valueOf() ?? now.valueOf() + 60_000) - now.valueOf(),
      );
      throw new ResearchWriteError(
        "RATE_LIMITED",
        "The Agent protected-action intent rate limit has been reached.",
        {
          details: {
            limit: this.#protectedActionIntentsPerHour,
            limit_dimension: "protected_action_intent",
          },
          retryable: true,
          retryAfterMs,
        },
      );
    }
    if (window.active_pending_count >= this.#activePendingActionsPerAgent) {
      const retryAfterMs = Math.max(
        1,
        (window.active_retry_at?.valueOf() ?? now.valueOf() + 60_000) - now.valueOf(),
      );
      throw new ResearchWriteError(
        "RATE_LIMITED",
        "The Agent active PendingAction limit has been reached.",
        {
          details: {
            limit: this.#activePendingActionsPerAgent,
            limit_dimension: "active_pending_actions",
          },
          retryable: true,
          retryAfterMs,
        },
      );
    }
  }

  async #loadReplyTarget(
    transaction: TransactionSql,
    parentContentId: string,
  ): Promise<ReplyTarget> {
    const rows = await transaction<ParentRow[]>`
      select
        parent.depth,
        parent.lifecycle_state as parent_lifecycle_state,
        parent.distribution_state as parent_distribution_state,
        root.id as root_id,
        root.lifecycle_state as root_lifecycle_state,
        root.distribution_state as root_distribution_state,
        root.primary_community_id
      from platform.content_items as parent
      join platform.content_items as root on root.id = parent.root_id
      where parent.id = ${parentContentId}
      limit 1
      for share of parent, root
    `;
    const row = rows[0];
    if (
      !row ||
      row.parent_lifecycle_state !== "published" ||
      row.root_lifecycle_state !== "published" ||
      row.parent_distribution_state === "hidden" ||
      row.root_distribution_state === "hidden"
    ) {
      throw new ResearchWriteError(
        "CONTENT_NOT_FOUND",
        "The reply parent is unavailable.",
      );
    }
    if (row.depth >= 100) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "The maximum discussion depth has been reached.",
        { details: { field: "parent_content_id" } },
      );
    }
    const additional = await transaction<{ community_id: string }[]>`
      select community_id
      from platform.content_additional_communities
      where content_id = ${row.root_id}
      order by position
    `;
    return {
      communityIds: [
        row.primary_community_id,
        ...additional.map((item) => item.community_id),
      ],
      depth: row.depth + 1,
      parentContentId,
      rootContentId: row.root_id,
    };
  }

  async #resolveWriteFacts(
    transaction: TransactionSql,
    command: NormalizedResearchCommand,
  ): Promise<ResolvedWriteFacts> {
    const symbolIds: string[] = [];
    if (command.symbols.length > 0) {
      const rows = await transaction<ClassificationRow[]>`
        select symbol.id, symbol.ticker::text as value
        from platform.symbols as symbol
        where symbol.ticker::text = any(${transaction.array(command.symbols)}::text[])
          and symbol.status = 'active'
        order by symbol.ticker::text, symbol.exchange, symbol.id
        for share
      `;
      const byTicker = new Map<string, string[]>();
      for (const row of rows) {
        const existing = byTicker.get(row.value) ?? [];
        existing.push(row.id);
        byTicker.set(row.value, existing);
      }
      for (const ticker of command.symbols) {
        const matching = byTicker.get(ticker) ?? [];
        if (matching.length !== 1) {
          throw new ResearchWriteError(
            "VALIDATION_ERROR",
            matching.length === 0
              ? "A requested symbol is not in the active curated catalog."
              : "A requested symbol is ambiguous across active exchanges.",
            { details: { field: "symbols", symbol: ticker } },
          );
        }
        symbolIds.push(matching[0]!);
      }
    }

    const topicIds: string[] = [];
    if (command.topics.length > 0) {
      const rows = await transaction<ClassificationRow[]>`
        select topic.id, topic.slug::text as value
        from platform.topics as topic
        where topic.slug::text = any(${transaction.array(command.topics)}::text[])
          and topic.deleted_at is null
        order by topic.slug::text, topic.id
        for share
      `;
      const bySlug = new Map(rows.map((row) => [row.value, row.id]));
      for (const slug of command.topics) {
        const id = bySlug.get(slug);
        if (!id) {
          throw new ResearchWriteError(
            "VALIDATION_ERROR",
            "A requested topic is not in the active curated catalog.",
            { details: { field: "topics", topic: slug } },
          );
        }
        topicIds.push(id);
      }
    }

    const referenceTargetIds = new Set(
      command.references.map((reference) => reference.targetContentId),
    );
    if (referenceTargetIds.size > 0) {
      const rows = await transaction<{ id: string }[]>`
        select content.id
        from platform.content_items as content
        where content.id = any(${transaction.array([...referenceTargetIds])}::uuid[])
          and content.lifecycle_state = 'published'
          and content.distribution_state <> 'hidden'
        for share
      `;
      if (rows.length !== referenceTargetIds.size) {
        throw new ResearchWriteError(
          "CONTENT_NOT_FOUND",
          "At least one referenced ContentItem is unavailable.",
        );
      }
    }

    const handles = mentionHandles(command.bodyMarkdown);
    let mentionActorIds: string[] = [];
    if (handles.length > 0) {
      const rows = await transaction<MentionRow[]>`
        select actor.id as actor_id, lower(actor.handle::text) as handle
        from platform.actors as actor
        where lower(actor.handle::text) = any(${transaction.array(handles)}::text[])
          and actor.status in ('active', 'restricted')
          and actor.deleted_at is null
        for share
      `;
      const byHandle = new Map(rows.map((row) => [row.handle, row.actor_id]));
      mentionActorIds = handles
        .map((handle) => byHandle.get(handle))
        .filter((id): id is string => id !== undefined);
      if (mentionActorIds.length > 100) {
        throw new ResearchWriteError(
          "VALIDATION_ERROR",
          "A Revision cannot contain more than 100 resolved mentions.",
          { details: { field: "body_markdown" } },
        );
      }
    }

    return { mentionActorIds, referenceTargetIds, symbolIds, topicIds };
  }

  async #createPendingAction(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      channel: string;
      command: NormalizedResearchCommand;
      context: AgentCredentialContext;
      decisionId: string;
      digestBytes: Buffer;
      digestText: string;
      evaluation: AgentOperationEvaluation;
      idempotencyId: string;
      idempotencyKey: string;
      now: Date;
      principalScopeKey: string;
      requestId: string;
    },
  ): Promise<ResearchWriteOutcome> {
    const actionId = this.#newId("pending_action_id");
    const auditId = this.#newId("audit_id");
    const outboxId = this.#newId("outbox_event_id");
    const expiresAt = new Date(input.now.valueOf() + this.#pendingActionTtlMs);
    const approvalSummary =
      input.command.operation === "create_post"
        ? `Create one post in ${1 + input.command.additionalCommunityIds.length} ${input.command.additionalCommunityIds.length === 0 ? "Community" : "Communities"}.`
        : "Create one reply in an existing discussion.";
    const encrypted = encryptPendingCommand(
      input.command,
      {
        actionId,
        ownerId: input.context.owner.id,
        agentId: input.context.agent.id,
        credentialId: input.context.credential.id,
        operation: input.command.operation,
        inputDigest: input.digestText,
      },
      this.#keyRing,
    );
    const targetId = intendedTargetId(input.command);
    const targetType =
      input.command.operation === "create_post" ? "community" : "content";

    await this.#writeOutboxEvent(transaction, {
      aggregateId: actionId,
      aggregateType: "pending_action",
      eventId: outboxId,
      eventType: "action.pending_approval",
      now: input.now,
      payload: {
        action_id: actionId,
        actor_id: input.authorization.actor_id,
        agent_id: input.context.agent.id,
        operation: input.command.operation,
        owner_id: input.context.owner.id,
        target_id: targetId,
        target_type: targetType,
      },
    });
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        pending_action_id: actionId,
        state: "pending_approval",
      },
      agentId: input.context.agent.id,
      auditId,
      channel: input.channel,
      credentialId: input.context.credential.id,
      decision: "require_approval",
      decisionId: input.decisionId,
      errorCode: null,
      evaluation: input.evaluation,
      outcome: "pending",
      occurredAt: input.now,
      outboxId,
      ownerId: input.context.owner.id,
      policy: input.authorization,
      requestId: input.requestId,
      targetId,
      targetType,
    });
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
        normalized_input_format_version,
        input_digest,
        idempotency_key,
        idempotency_record_id,
        decision_id,
        policy_id,
        policy_version,
        policy_snapshot,
        approval_summary,
        state,
        requested_at,
        expires_at,
        audit_id,
        updated_at
      )
      values (
        ${actionId},
        ${input.context.owner.id},
        ${input.context.agent.id},
        ${input.context.credential.id},
        ${input.principalScopeKey},
        ${input.command.operation},
        ${targetType},
        ${targetId},
        ${encrypted.ciphertext},
        ${encrypted.nonce},
        ${encrypted.keyVersion},
        ${encrypted.formatVersion},
        ${input.digestBytes},
        ${input.idempotencyKey},
        ${input.idempotencyId},
        ${input.decisionId},
        ${input.authorization.policy_id},
        ${input.authorization.policy_version},
        ${transaction.json(
          policySnapshot(input.authorization, input.evaluation, input.decisionId),
        )},
        ${approvalSummary},
        'pending_approval',
        ${input.now},
        ${expiresAt},
        ${auditId},
        ${input.now}
      )
    `;

    const outcome: ResearchWriteOutcome = {
      decision: "require_approval",
      error: null,
      operation: input.command.operation,
      pendingAction: {
        approvalSummary,
        decisionId: input.decisionId,
        expiresAt,
        id: actionId,
        inputDigest: input.digestText,
        operation: input.command.operation,
        policyVersion: input.authorization.policy_version,
        requestedAt: input.now,
        state: "pending_approval",
      },
      replayed: false,
      result: null,
      status: "pending_approval",
    };
    await transaction`
      update platform.idempotency_records
      set status = 'pending_approval',
          response_code = 202,
          response_body = ${transaction.json(
            serializeOutcome(outcome) as unknown as postgres.JSONValue,
          )},
          resource_id = ${actionId},
          updated_at = ${input.now}
      where id = ${input.idempotencyId}
        and status = 'in_progress'
        and terminal_at is null
    `;
    return outcome;
  }

  async #commitAutonomousContent(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      channel: string;
      command: NormalizedResearchCommand;
      context: AgentCredentialContext;
      decisionId: string;
      evaluation: AgentOperationEvaluation;
      facts: ResolvedWriteFacts;
      idempotencyId: string;
      now: Date;
      preparedRevision: PreparedRevision;
      replyTarget: ReplyTarget | null;
      requestId: string;
    },
  ): Promise<ResearchWriteOutcome> {
    const contentId = this.#newId("content_id");
    const revisionId = this.#newId("revision_id");
    const outboxId = this.#newId("outbox_event_id");
    const auditId = this.#newId("audit_id");
    const postCommand = input.command.operation === "create_post" ? input.command : null;
    const isPost = postCommand !== null;
    if (!isPost && input.replyTarget === null) {
      throw new Error("A reply target is required for reply persistence.");
    }
    const rootId = isPost ? contentId : input.replyTarget!.rootContentId;
    const parentId = isPost ? null : input.replyTarget!.parentContentId;
    const depth = isPost ? 0 : input.replyTarget!.depth;
    const primaryCommunityId = postCommand?.primaryCommunityId ?? null;

    await transaction`
      insert into platform.content_items (
        id,
        version,
        kind,
        author_actor_id,
        primary_community_id,
        root_id,
        parent_id,
        depth,
        current_revision_id,
        lifecycle_state,
        distribution_state,
        erasure_state,
        published_at,
        created_at,
        updated_at
      )
      values (
        ${contentId},
        1,
        ${isPost ? "post" : "reply"},
        ${input.authorization.actor_id},
        ${primaryCommunityId},
        ${rootId},
        ${parentId},
        ${depth},
        null,
        'published',
        'normal',
        'retained',
        ${input.now},
        ${input.now},
        ${input.now}
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
        edit_summary,
        created_by_actor_id,
        created_at,
        source_version,
        content_hash,
        public_node_serialized_bytes
      )
      values (
        ${revisionId},
        ${contentId},
        1,
        ${postCommand?.title ?? null},
        ${input.command.bodyMarkdown},
        ${input.preparedRevision.bodyPlainText},
        null,
        ${input.authorization.actor_id},
        ${input.now},
        1,
        ${input.preparedRevision.contentHash},
        ${input.preparedRevision.publicNodeBytes}
      )
    `;
    await transaction`
      update platform.content_items
      set current_revision_id = ${revisionId}
      where id = ${contentId}
        and current_revision_id is null
        and version = 1
    `;

    if (isPost) {
      for (const [index, communityId] of postCommand.additionalCommunityIds.entries()) {
        await transaction`
          insert into platform.content_additional_communities (
            content_id,
            community_id,
            position,
            created_at
          )
          values (${contentId}, ${communityId}, ${index + 1}, ${input.now})
        `;
      }
    }
    for (const [index, symbolId] of input.facts.symbolIds.entries()) {
      await transaction`
        insert into platform.content_symbols (
          content_id,
          symbol_id,
          position,
          created_at
        )
        values (${contentId}, ${symbolId}, ${index + 1}, ${input.now})
      `;
    }
    for (const [index, topicId] of input.facts.topicIds.entries()) {
      await transaction`
        insert into platform.content_topics (
          content_id,
          topic_id,
          position,
          created_at
        )
        values (${contentId}, ${topicId}, ${index + 1}, ${input.now})
      `;
    }
    for (const [index, source] of input.command.sourceLinks.entries()) {
      await transaction`
        insert into platform.source_links (
          id,
          content_id,
          position,
          url,
          normalized_url_hash,
          title,
          description,
          added_revision_id,
          added_by_actor_id,
          added_at
        )
        values (
          ${this.#newId("source_link_id")},
          ${contentId},
          ${index + 1},
          ${source.url},
          ${createHash("sha256").update(source.url, "utf8").digest()},
          ${source.title ?? null},
          ${source.description ?? null},
          ${revisionId},
          ${input.authorization.actor_id},
          ${input.now}
        )
      `;
    }
    for (const [index, reference] of input.command.references.entries()) {
      await transaction`
        insert into platform.content_relations (
          id,
          from_content_id,
          to_content_id,
          position,
          relation_type,
          added_revision_id,
          created_at
        )
        values (
          ${this.#newId("content_relation_id")},
          ${contentId},
          ${reference.targetContentId},
          ${index + 1},
          ${reference.relationType},
          ${revisionId},
          ${input.now}
        )
      `;
    }
    for (const [index, mentionedActorId] of input.facts.mentionActorIds.entries()) {
      await transaction`
        insert into platform.mentions (
          revision_id,
          content_id,
          revision_number,
          mentioned_actor_id,
          position,
          created_at
        )
        values (
          ${revisionId},
          ${contentId},
          1,
          ${mentionedActorId},
          ${index + 1},
          ${input.now}
        )
      `;
    }

    const communityIds = isPost
      ? [postCommand.primaryCommunityId, ...postCommand.additionalCommunityIds]
      : input.replyTarget!.communityIds;
    await this.#writeOutboxEvent(transaction, {
      aggregateId: contentId,
      aggregateType: "content",
      eventId: outboxId,
      eventType: isPost ? "content.published" : "content.reply",
      now: input.now,
      payload: {
        actor_id: input.authorization.actor_id,
        community_ids: communityIds,
        content_id: contentId,
        kind: isPost ? "post" : "reply",
        parent_content_id: parentId,
        revision_id: revisionId,
        root_content_id: rootId,
        symbol_ids: input.facts.symbolIds,
        topic_ids: input.facts.topicIds,
      },
    });
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        content_id: contentId,
        resource_version: 1,
        revision_id: revisionId,
        root_content_id: rootId,
      },
      agentId: input.context.agent.id,
      auditId,
      channel: input.channel,
      credentialId: input.context.credential.id,
      decision: "allow",
      decisionId: input.decisionId,
      errorCode: null,
      evaluation: input.evaluation,
      outcome: "succeeded",
      occurredAt: input.now,
      outboxId,
      ownerId: input.context.owner.id,
      policy: input.authorization,
      requestId: input.requestId,
      targetId: contentId,
      targetType: "content",
    });

    const result: CreatePostResearchResult | ReplyResearchResult = isPost
      ? { contentId, resourceVersion: 1, revisionId }
      : {
          contentId,
          resourceVersion: 1,
          revisionId,
          rootContentId: rootId,
        };
    const outcome: ResearchWriteOutcome = {
      decision: "allow",
      error: null,
      operation: input.command.operation,
      pendingAction: null,
      replayed: false,
      result,
      status: "succeeded",
    };
    await this.#finalizeIdempotency(
      transaction,
      input.idempotencyId,
      "succeeded",
      201,
      outcome,
      contentId,
      input.now,
    );
    return outcome;
  }

  async #writeOutboxEvent(
    transaction: TransactionSql,
    event: {
      aggregateId: string;
      aggregateType: "content" | "pending_action";
      eventId: string;
      eventType: "action.pending_approval" | "content.published" | "content.reply";
      now: Date;
      payload: postgres.JSONValue;
    },
  ): Promise<void> {
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
        ${event.eventId},
        ${event.aggregateType},
        ${event.aggregateId},
        1,
        ${event.eventType},
        1,
        ${transaction.json(event.payload)},
        ${event.now},
        ${event.now},
        ${event.now}
      )
    `;
  }

  async #writeActionLog(
    transaction: TransactionSql,
    event: {
      action: string;
      actorId: string;
      after: postgres.JSONValue;
      agentId: string;
      auditId: string;
      channel: string;
      credentialId: string;
      decision: ResearchWriteDecision;
      decisionId: string;
      errorCode: string | null;
      evaluation: AgentOperationEvaluation;
      outcome: "succeeded" | "pending" | "denied" | "failed";
      occurredAt: Date;
      outboxId: string | null;
      ownerId: string;
      policy: AuthorizationRow;
      reasonCode?: string | undefined;
      requestId: string;
      targetId: string;
      targetType: "community" | "content";
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
        ${event.auditId},
        'domain_write',
        ${event.occurredAt},
        ${event.actorId},
        'agent',
        ${event.ownerId},
        ${event.agentId},
        ${event.credentialId},
        ${event.channel},
        ${event.decision === "allow" ? "policy_auto" : null},
        'agent_credential',
        ${transaction.json(
          policySnapshot(event.policy, event.evaluation, event.decisionId),
        )},
        ${event.action},
        ${event.targetType},
        ${event.targetId},
        ${event.decision},
        ${event.outcome},
        ${event.errorCode},
        ${event.outboxId},
        ${event.policy.policy_version},
        ${event.requestId},
        ${transaction.json(event.after)},
        ${event.reasonCode ?? event.evaluation.reason.toLocaleLowerCase("en-US")}
      )
    `;
  }

  async #finalizeIdempotency(
    transaction: TransactionSql,
    id: string,
    status: "succeeded" | "denied" | "failed",
    responseCode: number,
    outcome: ResearchWriteOutcome,
    resourceId: string | null,
    now: Date,
  ): Promise<void> {
    const minimumExpiry = new Date(now.valueOf() + IDEMPOTENCY_MIN_RETENTION_MS);
    await transaction`
      update platform.idempotency_records
      set status = ${status},
          response_code = ${responseCode},
          response_body = ${transaction.json(
            serializeOutcome(outcome) as unknown as postgres.JSONValue,
          )},
          resource_id = ${resourceId},
          terminal_at = ${now},
          expires_at = greatest(expires_at, ${minimumExpiry}),
          updated_at = ${now}
      where id = ${id}
        and status = 'in_progress'
        and terminal_at is null
    `;
  }
}

function actionName(operation: ResearchWriteOperation): string {
  return operation === "create_post" ? "content.create_post" : "content.reply_to_content";
}

function intendedTargetId(command: NormalizedResearchCommand): string {
  return command.operation === "create_post"
    ? command.primaryCommunityId
    : command.parentContentId;
}
