import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { appendOutboxEvent, type PostgresClient } from "@alphanet/database";
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
  decryptPendingCommand,
  encryptPendingCommand,
  PendingCommandCodecError,
  type PendingCommandKeyRing,
} from "./pending-command-codec.js";
import type {
  FencedPendingAction,
  PendingActionCommittedState,
  PendingActionExecutionClaim,
  PendingActionExecutionSuccessInput,
  PendingActionExecutionSuccessResult,
} from "./pending-action-execution.js";
import { PENDING_ACTION_STATES, type PendingActionState } from "./pending-action.js";
import {
  digestResearchCommand,
  digestResearchCommandBytes,
  freezeResearchCommandMentionActors,
  freezeUpdateContentBaseline,
  normalizeCreatePostCommand,
  normalizeReplyCommand,
  normalizeUpdateContentCommand,
  ResearchCommandValidationError,
  type CreatePostCommandInput,
  type FrozenUpdateContentBaseline,
  type NormalizedResearchCommand,
  type NormalizedResearchContentReference,
  type NormalizedResearchSourceLink,
  type NormalizedUpdateContentCommand,
  type ReplyCommandInput,
  type UpdateContentCommandInput,
} from "./research-command.js";
import {
  extractMarkdownMentionHandles,
  MarkdownComplexityLimitError,
  MarkdownMentionLimitError,
} from "./markdown-mentions.js";
import {
  AGENT_POLICY_CONTROL_MIGRATION_CHECKSUM,
  CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM,
  PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM,
} from "./schema-migrations.js";

const BODY_BYTES_LIMIT = 160 * 1_024;
const COMMAND_BYTES_LIMIT = 1_024 * 1_024;
const DEFAULT_ACTIVE_PENDING_ACTIONS_PER_AGENT = 20;
const DEFAULT_PROTECTED_ACTION_INTENTS_PER_HOUR = 20;
const AGENT_CONTENT_RATE_RULE_VERSION = "agent-content-rate-v1";
const AGENT_CONTENT_RATE_WINDOW_MS = 60 * 60 * 1_000;
const NEW_AGENT_CONTENT_RATE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_AGENT_CONTENT_RATE_LIMITS: AgentContentRateLimits = {
  establishedPostsPerHour: 6,
  establishedRepliesPerHour: 30,
  newAgentPostsPerHour: 2,
  newAgentRepliesPerHour: 10,
};
const IDEMPOTENCY_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PUBLIC_NODE_BYTES = 768 * 1_024;
const SOURCE_METADATA_BYTES_LIMIT = 128 * 1_024;
const PENDING_COMMAND_KEY_BYTES = 32;
const ACTION_LOG_HMAC_KEY_DOMAIN =
  "alphanet.research-write.action-log.idempotency-key-digest.key.v1";
const ACTION_LOG_HMAC_VALUE_DOMAIN =
  "alphanet.research-write.action-log.idempotency-key-digest.value.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_ACTION_STATE_SET = new Set<string>(PENDING_ACTION_STATES);
const RESEARCH_WRITE_ERROR_CODE_SET = new Set<string>([
  "ACTION_CANCELLED",
  "ACTION_EXECUTION_FAILED",
  "ACTION_EXPIRED",
  "ACTION_INVALIDATED",
  "ACTION_REJECTED",
  "AUTHORIZATION_CONTEXT_STALE",
  "COMMUNITY_NOT_FOUND",
  "COMMUNITY_RESTRICTED",
  "CONTENT_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_RESULT_CORRUPT",
  "NOT_CONTENT_AUTHOR",
  "POLICY_DENIED",
  "RATE_LIMITED",
  "REPLIES_CLOSED",
  "SCOPE_REQUIRED",
  "VALIDATION_ERROR",
  "VERSION_CONFLICT",
] satisfies ResearchWriteErrorCode[]);

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
export type ResearchWriteOperation =
  "create_post" | "reply_to_content" | "update_content";
type NewResearchCommand = Exclude<
  NormalizedResearchCommand,
  NormalizedUpdateContentCommand
>;

export type ResearchWriteErrorCode =
  | "ACTION_CANCELLED"
  | "ACTION_EXECUTION_FAILED"
  | "ACTION_EXPIRED"
  | "ACTION_INVALIDATED"
  | "ACTION_REJECTED"
  | "AUTHORIZATION_CONTEXT_STALE"
  | "COMMUNITY_NOT_FOUND"
  | "COMMUNITY_RESTRICTED"
  | "CONTENT_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_RESULT_CORRUPT"
  | "NOT_CONTENT_AUTHOR"
  | "POLICY_DENIED"
  | "RATE_LIMITED"
  | "REPLIES_CLOSED"
  | "SCOPE_REQUIRED"
  | "VALIDATION_ERROR"
  | "VERSION_CONFLICT";

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

export interface UpdateContentResearchWriteInput extends UpdateContentCommandInput {
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

export interface UpdateContentResearchResult {
  contentId: string;
  resourceVersion: number;
  revisionId: string | null;
}

export interface ResearchPendingActionSummary {
  approvalSummary: string;
  decisionId: string;
  expiresAt: Date;
  id: string;
  inputDigest: string;
  operation: ResearchWriteOperation;
  expectedVersion?: number | undefined;
  policyVersion: string;
  requestedAt: Date;
  state: PendingActionState;
}

export interface ResearchWriteOutcome {
  decision: ResearchWriteDecision;
  error: ResearchWriteErrorDetail | null;
  operation: ResearchWriteOperation;
  pendingAction: ResearchPendingActionSummary | null;
  replayed: boolean;
  result:
    CreatePostResearchResult | ReplyResearchResult | UpdateContentResearchResult | null;
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
  updateContent(
    context: AgentCredentialContext,
    input: UpdateContentResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome>;
}

export type ApprovedResearchExecutionDisposition = "invalidate" | "retry";

export class ApprovedResearchExecutionError extends Error {
  readonly code: "APPROVED_ACTION_CONTEXT_INVALID" | "APPROVED_ACTION_RATE_LIMITED";
  readonly disposition: ApprovedResearchExecutionDisposition;
  readonly retryAfterMs: number | null;

  constructor(
    code: "APPROVED_ACTION_CONTEXT_INVALID" | "APPROVED_ACTION_RATE_LIMITED",
    options: { retryAfterMs?: number | null | undefined } = {},
  ) {
    super(
      code === "APPROVED_ACTION_RATE_LIMITED"
        ? "The approved action must be retried later."
        : "The approved action is no longer valid.",
    );
    this.name = "ApprovedResearchExecutionError";
    this.code = code;
    this.disposition = code === "APPROVED_ACTION_RATE_LIMITED" ? "retry" : "invalidate";
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface ApprovedResearchExecutionRepository {
  finalizeSucceeded(
    transaction: TransactionSql,
    claim: PendingActionExecutionClaim,
    input: PendingActionExecutionSuccessInput,
  ): Promise<PendingActionExecutionSuccessResult>;
  withFencedClaim<T>(
    claim: PendingActionExecutionClaim,
    callback: (transaction: TransactionSql, action: FencedPendingAction) => Promise<T>,
  ): Promise<T>;
}

export interface ApprovedResearchExecutionResult {
  action: PendingActionCommittedState;
  content: CreatePostResearchResult | ReplyResearchResult | UpdateContentResearchResult;
  resolvedOutboxEventId: string;
}

interface ApprovedResearchRateLimitCommit {
  rateLimited: true;
  retryAfterMs: number;
}

interface ResearchActionAuditDigests {
  readonly idempotencyKeyDigest: string;
  readonly inputDigest: string;
}

export interface PostgresResearchWriteOptions {
  activePendingActionsPerAgent?: number | undefined;
  agentContentRateLimits?: AgentContentRateLimits | undefined;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  idempotencyRetentionMs?: number | undefined;
  pendingActionKeyRing: PendingCommandKeyRing;
  pendingActionTtlMs?: number | undefined;
  protectedActionIntentsPerHour?: number | undefined;
}

export interface AgentContentRateLimits {
  readonly establishedPostsPerHour: number;
  readonly establishedRepliesPerHour: number;
  readonly newAgentPostsPerHour: number;
  readonly newAgentRepliesPerHour: number;
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

interface ResearchFactsInput {
  references: readonly NormalizedResearchContentReference[];
  symbols: readonly string[];
  topics: readonly string[];
}

interface PreparedRevision {
  bodyPlainText: string;
  contentHash: Buffer;
  publicNodeBytes: number;
}

interface PersistedResearchContent {
  contentId: string;
  outboxId: string;
  result: CreatePostResearchResult | ReplyResearchResult;
  revisionId: string;
  rootContentId: string;
}

interface UpdateTargetRow {
  author_actor_id: string;
  body_markdown: string;
  current_revision_id: string;
  current_revision_number: number;
  depth: number;
  distribution_state: string;
  kind: "post" | "reply";
  lifecycle_state: string;
  parent_id: string | null;
  primary_community_id: string | null;
  root_id: string;
  title: string | null;
  version: number;
}

interface CurrentSourceRow {
  description: string | null;
  title: string | null;
  url: string;
}

interface CurrentReferenceRow {
  relation_type: "quote" | "reference";
  target_content_id: string;
}

interface CurrentAdditionalCommunityRow {
  community_id: string;
  created_at: Date;
}

interface PreparedContentUpdate {
  additionalCommunityIds: string[];
  additionalCommunityCreatedAtById: ReadonlyMap<string, Date>;
  bodyMarkdown: string;
  changedGroups: string[];
  classificationChanged: boolean;
  communityIds: string[];
  contentId: string;
  currentBodyMarkdown: string;
  currentCommunityIds: string[];
  currentMentionActorIds: string[];
  currentRevisionId: string;
  currentRevisionNumber: number;
  currentSources: NormalizedResearchSourceLink[];
  currentTitle: string | null;
  currentReferences: NormalizedResearchContentReference[];
  currentVersion: number;
  kind: "post" | "reply";
  newlyAddedCommunityIds: string[];
  primaryCommunityId: string | null;
  references: NormalizedResearchContentReference[];
  revisionChanged: boolean;
  rootContentId: string;
  sourceLinks: NormalizedResearchSourceLink[];
  symbols: string[];
  title: string | null;
  topics: string[];
}

interface PersistedContentUpdate {
  contentId: string;
  outboxId: string;
  result: UpdateContentResearchResult;
  rootContentId: string;
}

function frozenUpdateBaseline(
  prepared: PreparedContentUpdate,
): FrozenUpdateContentBaseline {
  const primaryCommunityId = prepared.currentCommunityIds[0];
  if (!primaryCommunityId) {
    throw new Error("An update baseline requires an effective primary Community.");
  }
  return {
    additionalCommunityIds: prepared.currentCommunityIds.slice(1),
    bodyMarkdown: prepared.currentBodyMarkdown,
    contentKind: prepared.kind,
    primaryCommunityId,
    resourceVersion: prepared.currentVersion,
    revisionId: prepared.currentRevisionId,
    title: prepared.currentTitle,
  };
}

function frozenUpdateBaselineMatches(
  actual: FrozenUpdateContentBaseline | undefined,
  prepared: PreparedContentUpdate,
): boolean {
  if (!actual) return false;
  const expected = frozenUpdateBaseline(prepared);
  return (
    actual.resourceVersion === expected.resourceVersion &&
    actual.revisionId === expected.revisionId &&
    actual.contentKind === expected.contentKind &&
    actual.title === expected.title &&
    actual.bodyMarkdown === expected.bodyMarkdown &&
    actual.primaryCommunityId === expected.primaryCommunityId &&
    actual.additionalCommunityIds.length === expected.additionalCommunityIds.length &&
    actual.additionalCommunityIds.every(
      (communityId, index) => communityId === expected.additionalCommunityIds[index],
    )
  );
}

interface ProtectedActionIntentWindow {
  active_pending_count: number;
  active_retry_at: Date | null;
  hourly_intent_count: number;
  hourly_retry_at: Date | null;
}

interface AgentContentRateWindow {
  succeeded_count: number;
  retry_at: Date | null;
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
    expected_version?: number | undefined;
    policy_version: string;
    requested_at: string;
    state: PendingActionState;
  };
  result: null | {
    content_id: string;
    resource_version: number;
    revision_id: string | null;
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
    case "ACTION_CANCELLED":
    case "ACTION_EXECUTION_FAILED":
    case "ACTION_EXPIRED":
    case "ACTION_INVALIDATED":
    case "ACTION_REJECTED":
      return 409;
    case "AUTHORIZATION_CONTEXT_STALE":
      return 401;
    case "COMMUNITY_NOT_FOUND":
    case "CONTENT_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "VERSION_CONFLICT":
      return 409;
    case "COMMUNITY_RESTRICTED":
    case "NOT_CONTENT_AUTHOR":
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
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

function validateCommandBudgets(command: NormalizedResearchCommand): string[] {
  const isPost = command.operation === "create_post";
  const isUpdate = command.operation === "update_content";
  const title = isPost ? command.title : isUpdate ? command.patch.title : undefined;
  const bodyMarkdown = isUpdate ? command.patch.bodyMarkdown : command.bodyMarkdown;
  const symbols = isUpdate ? (command.patch.symbols ?? []) : command.symbols;
  const topics = isUpdate ? (command.patch.topics ?? []) : command.topics;
  const sourceLinks = isUpdate ? (command.patch.sourceLinks ?? []) : command.sourceLinks;
  const references = isUpdate ? (command.patch.references ?? []) : command.references;
  const additionalCommunityIds = isPost
    ? command.additionalCommunityIds
    : isUpdate
      ? (command.patch.additionalCommunityIds ?? [])
      : [];
  const titleLength = title === undefined ? 0 : unicodeLength(title);

  if (title !== undefined && (titleLength < 5 || titleLength > 200)) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "Post titles must contain 5 through 200 Unicode characters.",
      { details: { field: "title" } },
    );
  }
  if (bodyMarkdown !== undefined) {
    const bodyLength = unicodeLength(bodyMarkdown);
    const bodyBytes = Buffer.byteLength(bodyMarkdown, "utf8");
    if (
      bodyMarkdown.trim().length === 0 ||
      bodyLength > (command.operation === "reply_to_content" ? 20_000 : 100_000) ||
      bodyBytes > BODY_BYTES_LIMIT
    ) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "The normalized Markdown body is outside the operation limits.",
        { details: { field: "body_markdown" } },
      );
    }
  }

  if (
    isUpdate &&
    command.editSummary !== undefined &&
    (unicodeLength(command.editSummary) > 500 || /\p{Cc}/u.test(command.editSummary))
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The edit summary must be control-free and at most 500 characters.",
      { details: { field: "edit_summary" } },
    );
  }

  let mentionHandles: string[] = [];
  if (bodyMarkdown !== undefined) {
    try {
      mentionHandles = extractMarkdownMentionHandles(bodyMarkdown, 100);
    } catch (error) {
      if (error instanceof MarkdownComplexityLimitError) {
        throw new ResearchWriteError(
          "VALIDATION_ERROR",
          "The Markdown body exceeds the safe structural complexity limit.",
          {
            details: {
              field: "body_markdown",
              reason_code: "MARKDOWN_TOO_COMPLEX",
            },
          },
        );
      }
      if (!(error instanceof MarkdownMentionLimitError)) throw error;
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "A Revision cannot contain more than 100 distinct mention candidates.",
        { details: { field: "body_markdown" } },
      );
    }
  }
  if (
    symbols.length > 10 ||
    topics.length > 5 ||
    sourceLinks.length > 50 ||
    references.length > 20 ||
    additionalCommunityIds.length > 4
  ) {
    throw new ResearchWriteError(
      "VALIDATION_ERROR",
      "The command exceeds a collection-size limit.",
    );
  }

  for (const source of sourceLinks) {
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
    Buffer.byteLength(JSON.stringify(sourceLinks), "utf8") > SOURCE_METADATA_BYTES_LIMIT
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
  } else if (command.operation === "reply_to_content") {
    assertUuid(command.parentContentId, "parent_content_id");
  } else {
    assertUuid(command.contentId, "content_id");
    for (const id of additionalCommunityIds) {
      assertUuid(id, "additional_community_ids");
    }
  }
  for (const reference of references) {
    assertUuid(reference.targetContentId, "references.target_content_id");
  }
  return mentionHandles;
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

function approvedExecutionPolicySnapshot(
  frozenPolicy: Readonly<Record<string, unknown>>,
  currentAuthorization: AuthorizationRow,
  currentEvaluation: AgentOperationEvaluation,
  decisionId: string,
  decisionAuditId: string,
): postgres.JSONValue {
  return {
    ...(frozenPolicy as Record<string, postgres.JSONValue>),
    decision: "require_approval",
    decision_id: decisionId,
    live_revalidation: {
      credential_ceiling_decision: currentEvaluation.credentialCeilingDecision,
      decision: currentEvaluation.decision,
      defaults_version: currentAuthorization.defaults_version,
      matched_scope: currentEvaluation.matchedScope,
      policy_id: currentAuthorization.policy_id,
      policy_schema_version: currentAuthorization.policy_schema_version,
      policy_tier: currentAuthorization.policy_tier,
      policy_version: currentAuthorization.policy_version,
      owner_policy_decision: currentEvaluation.ownerPolicyDecision,
      policy_rule_source: currentEvaluation.policyRuleSource,
      reason: currentEvaluation.reason,
      required_scopes: [...currentEvaluation.requiredScopes],
      scope_satisfied: currentEvaluation.scopeSatisfied,
    },
    owner_approval: {
      decision_audit_id: decisionAuditId,
      method: "owner_approval",
    },
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
            ...(outcome.pendingAction.expectedVersion === undefined
              ? {}
              : { expected_version: outcome.pendingAction.expectedVersion }),
          },
    error: outcome.error,
  };
}

function parseErrorDetail(value: unknown): ResearchWriteErrorDetail | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["code", "message", "retryable", "details", "retryAfterMs"]) ||
    typeof value.code !== "string" ||
    !RESEARCH_WRITE_ERROR_CODE_SET.has(value.code) ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 500 ||
    typeof value.retryable !== "boolean" ||
    !(
      value.details === null ||
      (isRecord(value.details) &&
        Object.values(value.details).every(
          (detail) =>
            detail === null ||
            typeof detail === "string" ||
            typeof detail === "number" ||
            typeof detail === "boolean",
        ))
    ) ||
    !(
      value.retryAfterMs === null ||
      (typeof value.retryAfterMs === "number" &&
        Number.isSafeInteger(value.retryAfterMs) &&
        value.retryAfterMs > 0)
    )
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
  const allowedStatusesByDecision = {
    allow: new Set<ResearchWriteStatus>(["succeeded", "failed"]),
    require_approval: new Set<ResearchWriteStatus>([
      "pending_approval",
      "succeeded",
      "denied",
      "failed",
    ]),
    deny: new Set<ResearchWriteStatus>(["denied"]),
  } as const;
  if (!allowedStatusesByDecision[value.decision].has(value.status)) {
    throw corruptIdempotencyResult();
  }

  let result:
    CreatePostResearchResult | ReplyResearchResult | UpdateContentResearchResult | null =
    null;
  if (value.result !== null) {
    const expectedResultKeys =
      operation === "reply_to_content"
        ? ["content_id", "revision_id", "resource_version", "root_content_id"]
        : ["content_id", "revision_id", "resource_version"];
    if (
      !isRecord(value.result) ||
      !hasExactKeys(value.result, expectedResultKeys) ||
      typeof value.result.content_id !== "string" ||
      !isUuid(value.result.content_id) ||
      !(
        (operation === "update_content" && value.result.revision_id === null) ||
        (typeof value.result.revision_id === "string" && isUuid(value.result.revision_id))
      ) ||
      typeof value.result.resource_version !== "number" ||
      !Number.isSafeInteger(value.result.resource_version) ||
      value.result.resource_version < 1
    ) {
      throw corruptIdempotencyResult();
    }
    if (operation === "reply_to_content") {
      result =
        typeof value.result.root_content_id === "string" &&
        isUuid(value.result.root_content_id) &&
        typeof value.result.revision_id === "string"
          ? {
              contentId: value.result.content_id,
              revisionId: value.result.revision_id,
              resourceVersion: value.result.resource_version,
              rootContentId: value.result.root_content_id,
            }
          : null;
    } else if (operation === "update_content") {
      result = {
        contentId: value.result.content_id,
        revisionId:
          typeof value.result.revision_id === "string" ? value.result.revision_id : null,
        resourceVersion: value.result.resource_version,
      };
    } else {
      result =
        typeof value.result.revision_id === "string"
          ? {
              contentId: value.result.content_id,
              revisionId: value.result.revision_id,
              resourceVersion: value.result.resource_version,
            }
          : null;
    }
    if (result === null) throw corruptIdempotencyResult();
  }

  let pendingAction: ResearchPendingActionSummary | null = null;
  if (value.pending_action !== null) {
    const pending = value.pending_action;
    if (
      !isRecord(pending) ||
      !hasExactKeys(
        pending,
        operation === "update_content"
          ? [
              "id",
              "operation",
              "state",
              "expires_at",
              "input_digest",
              "requested_at",
              "decision_id",
              "policy_version",
              "approval_summary",
              "expected_version",
            ]
          : [
              "id",
              "operation",
              "state",
              "expires_at",
              "input_digest",
              "requested_at",
              "decision_id",
              "policy_version",
              "approval_summary",
            ],
      ) ||
      typeof pending.id !== "string" ||
      !isUuid(pending.id) ||
      pending.operation !== operation ||
      !PENDING_ACTION_STATE_SET.has(String(pending.state)) ||
      typeof pending.expires_at !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/u.test(pending.expires_at) ||
      typeof pending.input_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(pending.input_digest) ||
      typeof pending.requested_at !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/u.test(pending.requested_at) ||
      typeof pending.decision_id !== "string" ||
      !isUuid(pending.decision_id) ||
      typeof pending.policy_version !== "string" ||
      pending.policy_version.length < 1 ||
      pending.policy_version.length > 200 ||
      typeof pending.approval_summary !== "string" ||
      pending.approval_summary.length < 1 ||
      pending.approval_summary.length > 2_000 ||
      pending.approval_summary.trim() !== pending.approval_summary ||
      /\p{Cc}/u.test(pending.approval_summary) ||
      (operation === "update_content" &&
        (typeof pending.expected_version !== "number" ||
          !Number.isSafeInteger(pending.expected_version) ||
          pending.expected_version < 1))
    ) {
      throw corruptIdempotencyResult();
    }
    const expiresAt = new Date(pending.expires_at);
    const requestedAt = new Date(pending.requested_at);
    if (
      Number.isNaN(expiresAt.valueOf()) ||
      Number.isNaN(requestedAt.valueOf()) ||
      expiresAt.valueOf() <= requestedAt.valueOf()
    ) {
      throw corruptIdempotencyResult();
    }
    const state = pending.state as PendingActionState;
    pendingAction = {
      id: pending.id,
      operation,
      state,
      expiresAt,
      inputDigest: pending.input_digest,
      requestedAt,
      decisionId: pending.decision_id,
      policyVersion: pending.policy_version,
      approvalSummary: pending.approval_summary,
      ...(operation === "update_content"
        ? { expectedVersion: pending.expected_version as number }
        : {}),
    };
  }

  const error = parseErrorDetail(value.error);
  if (
    (value.status === "succeeded" && (result === null || error !== null)) ||
    (value.status !== "succeeded" && result !== null) ||
    (value.status === "pending_approval" && (pendingAction === null || error !== null)) ||
    ((value.status === "denied" || value.status === "failed") && error === null) ||
    error?.code === "RATE_LIMITED" ||
    (value.decision !== "require_approval" && pendingAction !== null)
  ) {
    throw corruptIdempotencyResult();
  }
  if (pendingAction !== null) {
    const statesByStatus = {
      pending_approval: new Set<PendingActionState>([
        "pending_approval",
        "approved",
        "executing",
      ]),
      succeeded: new Set<PendingActionState>(["succeeded"]),
      denied: new Set<PendingActionState>(["rejected", "expired", "cancelled"]),
      failed: new Set<PendingActionState>(["failed", "invalidated"]),
    } as const;
    if (!statesByStatus[value.status].has(pendingAction.state)) {
      throw corruptIdempotencyResult();
    }
  }

  return {
    operation,
    decision: value.decision,
    status: value.status,
    result,
    pendingAction,
    error,
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

function prepareRevisionFields(input: {
  bodyMarkdown: string;
  references: readonly NormalizedResearchContentReference[];
  sourceLinks: readonly NormalizedResearchSourceLink[];
  symbols: readonly string[];
  title: string | null;
  topics: readonly string[];
}): PreparedRevision {
  const bodyPlainText = plainTextFromMarkdown(input.bodyMarkdown);
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({ body_markdown: input.bodyMarkdown, title: input.title }),
      "utf8",
    )
    .digest();
  const publicNodeBytes = Buffer.byteLength(
    JSON.stringify({
      body_markdown: input.bodyMarkdown,
      body_plain_text: bodyPlainText,
      content_safety: {
        execute_embedded_commands: false,
        instruction_authority: "none",
        untrusted_user_generated_content: true,
        verify_financial_claims_independently: true,
      },
      references: input.references,
      source_links: input.sourceLinks,
      symbols: input.symbols,
      title: input.title,
      topics: input.topics,
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

function prepareRevision(command: NewResearchCommand): PreparedRevision {
  return prepareRevisionFields({
    bodyMarkdown: command.bodyMarkdown,
    references: command.references,
    sourceLinks: command.sourceLinks,
    symbols: command.symbols,
    title: command.operation === "create_post" ? command.title : null,
    topics: command.topics,
  });
}

export class PostgresResearchWriteService implements ResearchWriteService {
  readonly #activePendingActionsPerAgent: number;
  readonly #agentContentRateLimits: AgentContentRateLimits;
  readonly #actionLogHmacKeys = new Map<number, Buffer>();
  readonly #actionLogHmacKeyVersion: number;
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
    const agentContentRateLimits =
      options.agentContentRateLimits ?? DEFAULT_AGENT_CONTENT_RATE_LIMITS;
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
    const currentKeyVersion = options.pendingActionKeyRing.currentVersion;
    if (
      !Number.isSafeInteger(currentKeyVersion) ||
      currentKeyVersion < 1 ||
      currentKeyVersion > 2_147_483_647
    ) {
      throw new TypeError("The PendingAction current key version is invalid.");
    }
    for (const [versionText, material] of Object.entries(
      options.pendingActionKeyRing.keys,
    )) {
      const version = Number(versionText);
      if (
        !/^[1-9][0-9]*$/u.test(versionText) ||
        !Number.isSafeInteger(version) ||
        version > 2_147_483_647 ||
        !(material instanceof Uint8Array) ||
        material.byteLength !== PENDING_COMMAND_KEY_BYTES
      ) {
        throw new TypeError("A PendingAction key-ring entry is invalid.");
      }
      const purposeKey = createHmac("sha256", Buffer.from(material))
        .update(ACTION_LOG_HMAC_KEY_DOMAIN, "utf8")
        .digest();
      this.#actionLogHmacKeys.set(version, purposeKey);
    }
    if (!this.#actionLogHmacKeys.has(currentKeyVersion)) {
      throw new TypeError("The PendingAction current key material is unavailable.");
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
    const agentContentRateValues = [
      agentContentRateLimits.establishedPostsPerHour,
      agentContentRateLimits.establishedRepliesPerHour,
      agentContentRateLimits.newAgentPostsPerHour,
      agentContentRateLimits.newAgentRepliesPerHour,
    ];
    if (
      agentContentRateValues.some(
        (limit) => !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000,
      ) ||
      agentContentRateLimits.newAgentPostsPerHour >
        agentContentRateLimits.establishedPostsPerHour ||
      agentContentRateLimits.newAgentRepliesPerHour >
        agentContentRateLimits.establishedRepliesPerHour
    ) {
      throw new RangeError(
        "Agent content rate limits must be integers from one through ten thousand, with new-Agent limits no greater than established-Agent limits.",
      );
    }
    this.#activePendingActionsPerAgent = activePendingActionsPerAgent;
    this.#agentContentRateLimits = { ...agentContentRateLimits };
    this.#actionLogHmacKeyVersion = currentKeyVersion;
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
          and exists (
            select 1
            from system.schema_migrations
            where version = '000007'
              and name = 'pending_action_execution'
              and checksum = ${PENDING_ACTION_EXECUTION_MIGRATION_CHECKSUM}
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
            where version = '000012'
              and name = 'content_revision_write'
              and checksum = ${CONTENT_REVISION_WRITE_MIGRATION_CHECKSUM}
          )
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.credentials')
              and attname = 'policy_ceiling_rules'
              and attnotnull
              and not attisdropped
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
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.content_revisions')
              and tgname = 'content_revisions_validate_current_pointer'
              and not tgisinternal
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new Error("Research write schema is not ready");
    }
  }

  async executeApprovedAction(
    repository: ApprovedResearchExecutionRepository,
    claim: PendingActionExecutionClaim,
  ): Promise<ApprovedResearchExecutionResult> {
    try {
      const result = await repository.withFencedClaim<
        ApprovedResearchExecutionResult | ApprovedResearchRateLimitCommit
      >(claim, async (transaction, frozenAction) => {
        await transaction`set local statement_timeout = '10s'`;
        if (
          (frozenAction.operation !== "create_post" &&
            frozenAction.operation !== "reply_to_content" &&
            frozenAction.operation !== "update_content") ||
          frozenAction.operation !== claim.operation ||
          (frozenAction.operation === "update_content"
            ? frozenAction.expectedVersion === null
            : frozenAction.expectedVersion !== null)
        ) {
          throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
        }

        const originalPolicy = frozenAction.policySnapshot;
        const decisionAuditId =
          typeof frozenAction.decisionAuditId === "string" &&
          isUuid(frozenAction.decisionAuditId)
            ? frozenAction.decisionAuditId
            : null;
        const originalDecisionId =
          isRecord(originalPolicy) &&
          originalPolicy.decision === "require_approval" &&
          typeof originalPolicy.decision_id === "string" &&
          originalPolicy.decision_id === frozenAction.decisionId &&
          originalPolicy.policy_id === frozenAction.policyId &&
          typeof originalPolicy.policy_version === "string" &&
          originalPolicy.policy_version === frozenAction.policyVersion &&
          isUuid(frozenAction.decisionId) &&
          decisionAuditId !== null
            ? frozenAction.decisionId
            : null;
        if (
          originalDecisionId === null ||
          decisionAuditId === null ||
          !isRecord(originalPolicy)
        ) {
          throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
        }

        const inputDigest = `sha256:${frozenAction.inputDigest.toString("hex")}`;
        const command = decryptPendingCommand(
          frozenAction.normalizedInput,
          {
            actionId: frozenAction.actionId,
            agentId: frozenAction.agentId,
            credentialId: frozenAction.credentialId,
            inputDigest,
            operation: frozenAction.operation,
            ownerId: frozenAction.ownerId,
          },
          this.#keyRing,
        );
        validateCommandBudgets(command);
        if (
          !sameDigest(digestResearchCommandBytes(command), frozenAction.inputDigest) ||
          command.operation !== frozenAction.operation ||
          frozenAction.targetId !== intendedTargetId(command) ||
          frozenAction.targetType !==
            (command.operation === "create_post" ? "community" : "content") ||
          (command.operation === "update_content" &&
            frozenAction.expectedVersion !== command.expectedVersion)
        ) {
          throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
        }
        const auditDigests = this.#actionAuditDigests(
          frozenAction.inputDigest,
          frozenAction.idempotencyKey,
          frozenAction.normalizedInput.keyVersion,
        );

        const clocks = await transaction<{ database_now: Date }[]>`
            select clock_timestamp() as database_now
          `;
        const now = clocks[0]?.database_now;
        if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
          throw new Error("The database did not return a valid execution clock.");
        }

        const authorization = await this.#loadApprovedAuthorization(
          transaction,
          frozenAction,
        );
        const evaluation = evaluateAgentOperation({
          credentialPolicyCeiling: authorization.credential_policy_ceiling,
          credentialPolicyCeilingDefaultsVersion:
            authorization.credential_policy_ceiling_defaults_version,
          credentialPolicyCeilingRules: authorization.credential_policy_ceiling_rules,
          credentialPolicyCeilingSchemaVersion:
            authorization.credential_policy_ceiling_schema_version,
          operation: command.operation,
          policyDefaultsVersion: authorization.defaults_version,
          policyRules: authorization.policy_rules,
          policySchemaVersion: authorization.policy_schema_version,
          policyTier: authorization.policy_tier,
          scopes: authorization.credential_scopes,
        });
        if (!evaluation.scopeSatisfied || evaluation.decision === "deny") {
          throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
        }

        try {
          return await transaction.savepoint(
            "approved_research_mutation",
            async (transaction) => {
              if (command.operation === "update_content") {
                const prepared = await this.#loadContentUpdateTarget(
                  transaction,
                  command,
                  authorization.actor_id,
                );
                if (
                  !frozenUpdateBaselineMatches(command.frozenUpdateBaseline, prepared)
                ) {
                  throw new ApprovedResearchExecutionError(
                    "APPROVED_ACTION_CONTEXT_INVALID",
                  );
                }
                let admissions = await this.#inspectCommunities(
                  transaction,
                  prepared.communityIds,
                );
                this.#enforceCommunityRules(
                  admissions,
                  prepared.kind === "post" ? "investment-research" : "discussion",
                  prepared.sourceLinks.length > 0,
                  prepared.kind === "reply",
                  false,
                );
                this.#enforceNewCommunityPlacementCapacity(
                  admissions,
                  prepared.newlyAddedCommunityIds,
                );
                await this.#materializeCatalogCommunities(transaction, admissions);
                admissions = await this.#inspectCommunities(
                  transaction,
                  prepared.communityIds,
                );
                if (
                  admissions.some(
                    (admission) => admission.materialization !== "materialized",
                  )
                ) {
                  throw new ResearchWriteError(
                    "COMMUNITY_NOT_FOUND",
                    "The catalog Community could not be materialized safely.",
                  );
                }
                this.#enforceCommunityRules(
                  admissions,
                  prepared.kind === "post" ? "investment-research" : "discussion",
                  prepared.sourceLinks.length > 0,
                  prepared.kind === "reply",
                  false,
                );
                this.#enforceNewCommunityPlacementCapacity(
                  admissions,
                  prepared.newlyAddedCommunityIds,
                );
                await this.#enforcePostRates(
                  transaction,
                  authorization.actor_id,
                  this.#newCommunityAdmissions(
                    admissions,
                    prepared.newlyAddedCommunityIds,
                  ),
                  now,
                );
                const facts = await this.#resolveWriteFacts(
                  transaction,
                  {
                    references: command.patch.references ?? [],
                    symbols: command.patch.symbols ?? [],
                    topics: command.patch.topics ?? [],
                  },
                  [],
                );
                facts.mentionActorIds = [...(command.frozenMentionActorIds ?? [])];
                await this.#enforceUpdateRates(
                  transaction,
                  authorization.actor_id,
                  prepared.contentId,
                  now,
                );
                const persisted = await this.#persistContentUpdate(transaction, {
                  actorId: authorization.actor_id,
                  command,
                  facts,
                  now,
                  prepared,
                });
                await this.#writeActionLog(transaction, {
                  action: actionName(command.operation),
                  actorId: authorization.actor_id,
                  after: {
                    changed_groups: prepared.changedGroups,
                    content_id: persisted.contentId,
                    idempotency_record_id: frozenAction.idempotencyRecordId,
                    pending_action_id: frozenAction.actionId,
                    resource_version: persisted.result.resourceVersion,
                    revision_id: persisted.result.revisionId,
                    root_content_id: persisted.rootContentId,
                  },
                  auditDigests,
                  agentId: frozenAction.agentId,
                  approvalMethod: "owner_approval",
                  approvedByOwnerId: frozenAction.ownerId,
                  auditId: this.#newId("audit_id"),
                  authenticationAssurance: "owner_approval_record",
                  channel: "worker",
                  credentialId: frozenAction.credentialId,
                  decision: "require_approval",
                  decisionId: originalDecisionId,
                  errorCode: null,
                  evaluation,
                  outcome: "succeeded",
                  occurredAt: now,
                  outboxId: persisted.outboxId,
                  ownerId: frozenAction.ownerId,
                  policy: authorization,
                  policySnapshotOverride: approvedExecutionPolicySnapshot(
                    originalPolicy,
                    authorization,
                    evaluation,
                    originalDecisionId,
                    decisionAuditId,
                  ),
                  requestId:
                    `worker:pending-action:${frozenAction.actionId}:` +
                    `attempt:${frozenAction.attemptCount}`,
                  targetId: persisted.contentId,
                  targetType: "content",
                });
                const terminal = await repository.finalizeSucceeded(transaction, claim, {
                  correlatedOutboxEventId: persisted.outboxId,
                  resourceId: persisted.contentId,
                  result: {
                    content_id: persisted.result.contentId,
                    resource_version: persisted.result.resourceVersion,
                    revision_id: persisted.result.revisionId,
                  },
                });
                return {
                  action: terminal.action,
                  content: persisted.result,
                  resolvedOutboxEventId: terminal.resolvedOutboxEventId,
                };
              }

              let replyTarget: ReplyTarget | null = null;
              if (command.operation === "create_post") {
                const targetIds = [
                  command.primaryCommunityId,
                  ...command.additionalCommunityIds,
                ];
                let admissions = await this.#inspectCommunities(transaction, targetIds);
                this.#enforceCommunityRules(
                  admissions,
                  "investment-research",
                  command.sourceLinks.length > 0,
                  false,
                );
                await this.#materializeCatalogCommunities(transaction, admissions);
                admissions = await this.#inspectCommunities(transaction, targetIds);
                if (
                  admissions.some(
                    (admission) => admission.materialization !== "materialized",
                  )
                ) {
                  throw new ResearchWriteError(
                    "COMMUNITY_NOT_FOUND",
                    "The catalog Community could not be materialized safely.",
                  );
                }
                this.#enforceCommunityRules(
                  admissions,
                  "investment-research",
                  command.sourceLinks.length > 0,
                  false,
                );
                await this.#enforcePostRates(
                  transaction,
                  authorization.actor_id,
                  admissions,
                  now,
                );
                await this.#enforceAgentContentRate(
                  transaction,
                  authorization,
                  frozenAction.agentId,
                  "create_post",
                  now,
                );
              } else {
                replyTarget = await this.#loadReplyTarget(
                  transaction,
                  command.parentContentId,
                );
                const admissions = await this.#inspectCommunities(
                  transaction,
                  replyTarget.communityIds,
                );
                this.#enforceCommunityRules(
                  admissions,
                  "discussion",
                  command.sourceLinks.length > 0,
                  true,
                );
                await this.#enforceAgentContentRate(
                  transaction,
                  authorization,
                  frozenAction.agentId,
                  "reply_to_content",
                  now,
                );
              }

              const facts = await this.#resolveWriteFacts(transaction, command, []);
              facts.mentionActorIds = [...(command.frozenMentionActorIds ?? [])];
              const preparedRevision = prepareRevision(command);
              const persisted = await this.#insertResearchContent(transaction, {
                authorization,
                command,
                facts,
                now,
                preparedRevision,
                replyTarget,
              });
              await this.#writeActionLog(transaction, {
                action: actionName(command.operation),
                actorId: authorization.actor_id,
                after: {
                  content_id: persisted.contentId,
                  idempotency_record_id: frozenAction.idempotencyRecordId,
                  pending_action_id: frozenAction.actionId,
                  resource_version: 1,
                  revision_id: persisted.revisionId,
                  root_content_id: persisted.rootContentId,
                },
                auditDigests,
                agentId: frozenAction.agentId,
                approvalMethod: "owner_approval",
                approvedByOwnerId: frozenAction.ownerId,
                auditId: this.#newId("audit_id"),
                authenticationAssurance: "owner_approval_record",
                channel: "worker",
                credentialId: frozenAction.credentialId,
                decision: "require_approval",
                decisionId: originalDecisionId,
                errorCode: null,
                evaluation,
                outcome: "succeeded",
                occurredAt: now,
                outboxId: persisted.outboxId,
                ownerId: frozenAction.ownerId,
                policy: authorization,
                policySnapshotOverride: approvedExecutionPolicySnapshot(
                  originalPolicy,
                  authorization,
                  evaluation,
                  originalDecisionId,
                  decisionAuditId,
                ),
                requestId:
                  `worker:pending-action:${frozenAction.actionId}:` +
                  `attempt:${frozenAction.attemptCount}`,
                targetId: persisted.contentId,
                targetType: "content",
              });

              const terminal = await repository.finalizeSucceeded(transaction, claim, {
                correlatedOutboxEventId: persisted.outboxId,
                resourceId: persisted.contentId,
                result:
                  command.operation === "create_post"
                    ? {
                        content_id: persisted.result.contentId,
                        resource_version: persisted.result.resourceVersion,
                        revision_id: persisted.result.revisionId,
                      }
                    : {
                        content_id: persisted.result.contentId,
                        resource_version: persisted.result.resourceVersion,
                        revision_id: persisted.result.revisionId,
                        root_content_id: (persisted.result as ReplyResearchResult)
                          .rootContentId,
                      },
              });
              return {
                action: terminal.action,
                content: persisted.result,
                resolvedOutboxEventId: terminal.resolvedOutboxEventId,
              };
            },
          );
        } catch (error) {
          if (!(error instanceof ResearchWriteError) || error.code !== "RATE_LIMITED") {
            throw error;
          }
          const retryAfterMs = error.retryAfterMs;
          if (
            !error.retryable ||
            retryAfterMs === null ||
            !Number.isSafeInteger(retryAfterMs) ||
            retryAfterMs < 1
          ) {
            throw new Error("An approved RATE_LIMITED result requires retry_after_ms.");
          }
          await this.#writeActionLog(transaction, {
            action: actionName(command.operation),
            actorId: authorization.actor_id,
            after: {
              error_code: error.code,
              ...(error.details ?? {}),
              pending_action_id: frozenAction.actionId,
              retry_after_ms: retryAfterMs,
            },
            auditDigests,
            agentId: frozenAction.agentId,
            approvalMethod: "owner_approval",
            approvedByOwnerId: frozenAction.ownerId,
            auditId: this.#newId("audit_id"),
            authenticationAssurance: "owner_approval_record",
            channel: "worker",
            credentialId: frozenAction.credentialId,
            decision: "require_approval",
            decisionId: originalDecisionId,
            errorCode: error.code,
            evaluation,
            outcome: "denied",
            occurredAt: now,
            outboxId: null,
            ownerId: frozenAction.ownerId,
            policy: authorization,
            policySnapshotOverride: approvedExecutionPolicySnapshot(
              originalPolicy,
              authorization,
              evaluation,
              originalDecisionId,
              decisionAuditId,
            ),
            reasonCode: "rate_limited",
            requestId:
              `worker:pending-action:${frozenAction.actionId}:` +
              `attempt:${frozenAction.attemptCount}`,
            targetId: intendedTargetId(command),
            targetType: command.operation === "create_post" ? "community" : "content",
          });
          return { rateLimited: true, retryAfterMs };
        }
      });
      if ("rateLimited" in result) {
        throw new ApprovedResearchExecutionError("APPROVED_ACTION_RATE_LIMITED", {
          retryAfterMs: result.retryAfterMs,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof ApprovedResearchExecutionError) throw error;
      if (error instanceof PendingCommandCodecError) {
        throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
      }
      if (error instanceof ResearchWriteError) {
        if (error.code === "RATE_LIMITED") {
          throw new ApprovedResearchExecutionError("APPROVED_ACTION_RATE_LIMITED", {
            retryAfterMs: error.retryAfterMs,
          });
        }
        throw new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID");
      }
      throw error;
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

  async updateContent(
    context: AgentCredentialContext,
    input: UpdateContentResearchWriteInput,
    request: ResearchWriteRequestContext,
  ): Promise<ResearchWriteOutcome> {
    return this.#dispatch(
      context,
      "update_content",
      () => normalizeUpdateContentCommand(input),
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
      credentialPolicyCeilingDefaultsVersion:
        context.credential.policyCeilingDefaultsVersion,
      credentialPolicyCeilingRules: context.credential.policyCeilingRules,
      credentialPolicyCeilingSchemaVersion: context.credential.policyCeilingSchemaVersion,
      operation,
      policyDefaultsVersion: context.agent.policy.defaultsVersion,
      policyRules: context.agent.policy.rules,
      policySchemaVersion: context.agent.policy.schemaVersion,
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
    const mentionHandles = validateCommandBudgets(command);
    const channel = validateRequestContext(request);

    const digestBytes = digestResearchCommandBytes(command);
    const digestText = digestResearchCommand(command);
    const auditDigests = this.#actionAuditDigests(digestBytes, idempotencyKey);
    const principalScopeKey = `credential:${context.credential.id}`;

    return this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '10s'`;
      const authorization = await this.#loadAuthorization(transaction, context);
      const evaluation = evaluateAgentOperation({
        credentialPolicyCeiling: authorization.credential_policy_ceiling,
        credentialPolicyCeilingDefaultsVersion:
          authorization.credential_policy_ceiling_defaults_version,
        credentialPolicyCeilingRules: authorization.credential_policy_ceiling_rules,
        credentialPolicyCeilingSchemaVersion:
          authorization.credential_policy_ceiling_schema_version,
        operation: command.operation,
        policyDefaultsVersion: authorization.defaults_version,
        policyRules: authorization.policy_rules,
        policySchemaVersion: authorization.policy_schema_version,
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
          auditDigests,
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

      if (command.operation === "update_content") {
        return this.#writeContentUpdate(transaction, {
          authorization,
          channel,
          command,
          context,
          decisionId,
          digestBytes,
          digestText,
          auditDigests,
          evaluation,
          idempotencyKey,
          mentionHandles,
          now,
          principalScopeKey,
          requestId: request.requestId,
        });
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
                await this.#enforceAgentContentRate(
                  admissionTransaction,
                  authorization,
                  context.agent.id,
                  "create_post",
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
            if (evaluation.decision === "allow") {
              await this.#enforceAgentContentRate(
                admissionTransaction,
                authorization,
                context.agent.id,
                "reply_to_content",
                now,
              );
            }
            return inspectedReplyTarget;
          },
        );
      } catch (error) {
        if (error instanceof ResearchWriteError && error.code === "RATE_LIMITED") {
          const outcome = rateLimitedOutcome(command.operation, error);
          await this.#commitTransientContentRateLimit(transaction, {
            authorization,
            channel,
            command,
            context,
            decisionId,
            error,
            evaluation,
            auditDigests,
            now,
            requestId: request.requestId,
          });
          return outcome;
        }
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
            auditDigests,
            idempotencyKey,
            now,
            principalScopeKey,
            requestId: request.requestId,
          });
        }
        throw error;
      }

      const facts = await this.#resolveWriteFacts(transaction, command, mentionHandles);
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
          auditDigests,
          evaluation,
          idempotencyId,
          idempotencyKey,
          mentionActorIds: facts.mentionActorIds,
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
        auditDigests,
        facts,
        idempotencyId,
        now,
        preparedRevision,
        replyTarget,
        requestId: request.requestId,
      });
    });
  }

  async #writeContentUpdate(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      auditDigests: ResearchActionAuditDigests;
      channel: string;
      command: NormalizedUpdateContentCommand;
      context: AgentCredentialContext;
      decisionId: string;
      digestBytes: Buffer;
      digestText: string;
      evaluation: AgentOperationEvaluation;
      idempotencyKey: string;
      mentionHandles: string[];
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

    try {
      return await transaction.savepoint(
        "content_update_mutation",
        async (mutationTransaction) => {
          const prepared = await this.#loadContentUpdateTarget(
            mutationTransaction,
            input.command,
            input.authorization.actor_id,
          );
          let admissions = await this.#inspectCommunities(
            mutationTransaction,
            prepared.communityIds,
          );
          this.#enforceCommunityRules(
            admissions,
            prepared.kind === "post" ? "investment-research" : "discussion",
            prepared.sourceLinks.length > 0,
            prepared.kind === "reply",
            false,
          );
          this.#enforceNewCommunityPlacementCapacity(
            admissions,
            prepared.newlyAddedCommunityIds,
          );
          if (input.evaluation.decision === "allow") {
            await this.#materializeCatalogCommunities(mutationTransaction, admissions);
            admissions = await this.#inspectCommunities(
              mutationTransaction,
              prepared.communityIds,
            );
            if (
              admissions.some((admission) => admission.materialization !== "materialized")
            ) {
              throw new ResearchWriteError(
                "COMMUNITY_NOT_FOUND",
                "The catalog Community could not be materialized safely.",
              );
            }
            this.#enforceCommunityRules(
              admissions,
              prepared.kind === "post" ? "investment-research" : "discussion",
              prepared.sourceLinks.length > 0,
              prepared.kind === "reply",
              false,
            );
            this.#enforceNewCommunityPlacementCapacity(
              admissions,
              prepared.newlyAddedCommunityIds,
            );
            await this.#enforcePostRates(
              mutationTransaction,
              input.authorization.actor_id,
              this.#newCommunityAdmissions(admissions, prepared.newlyAddedCommunityIds),
              input.now,
            );
          }

          const facts = await this.#resolveWriteFacts(
            mutationTransaction,
            {
              references: input.command.patch.references ?? [],
              symbols: input.command.patch.symbols ?? [],
              topics: input.command.patch.topics ?? [],
            },
            input.command.patch.bodyMarkdown === undefined ? [] : input.mentionHandles,
          );
          if (
            prepared.revisionChanged &&
            input.command.patch.bodyMarkdown === undefined
          ) {
            facts.mentionActorIds = [...prepared.currentMentionActorIds];
          }

          if (input.evaluation.decision === "require_approval") {
            return this.#createPendingAction(mutationTransaction, {
              authorization: input.authorization,
              channel: input.channel,
              command: input.command,
              context: input.context,
              decisionId: input.decisionId,
              digestBytes: input.digestBytes,
              digestText: input.digestText,
              auditDigests: input.auditDigests,
              evaluation: input.evaluation,
              idempotencyId,
              idempotencyKey: input.idempotencyKey,
              mentionActorIds: facts.mentionActorIds,
              now: input.now,
              principalScopeKey: input.principalScopeKey,
              requestId: input.requestId,
              updateBaseline: frozenUpdateBaseline(prepared),
            });
          }

          await this.#enforceUpdateRates(
            mutationTransaction,
            input.authorization.actor_id,
            prepared.contentId,
            input.now,
          );
          const persisted = await this.#persistContentUpdate(mutationTransaction, {
            actorId: input.authorization.actor_id,
            command: input.command,
            facts,
            now: input.now,
            prepared,
          });
          await this.#writeActionLog(mutationTransaction, {
            action: actionName(input.command.operation),
            actorId: input.authorization.actor_id,
            after: {
              changed_groups: prepared.changedGroups,
              content_id: persisted.contentId,
              idempotency_record_id: idempotencyId,
              resource_version: persisted.result.resourceVersion,
              revision_id: persisted.result.revisionId,
              root_content_id: persisted.rootContentId,
            },
            auditDigests: input.auditDigests,
            agentId: input.context.agent.id,
            auditId: this.#newId("audit_id"),
            channel: input.channel,
            credentialId: input.context.credential.id,
            decision: "allow",
            decisionId: input.decisionId,
            errorCode: null,
            evaluation: input.evaluation,
            outcome: "succeeded",
            occurredAt: input.now,
            outboxId: persisted.outboxId,
            ownerId: input.context.owner.id,
            policy: input.authorization,
            requestId: input.requestId,
            targetId: persisted.contentId,
            targetType: "content",
          });
          const outcome: ResearchWriteOutcome = {
            decision: "allow",
            error: null,
            operation: "update_content",
            pendingAction: null,
            replayed: false,
            result: persisted.result,
            status: "succeeded",
          };
          await this.#finalizeIdempotency(
            mutationTransaction,
            idempotencyId,
            "succeeded",
            200,
            outcome,
            persisted.contentId,
            input.now,
          );
          return outcome;
        },
      );
    } catch (error) {
      if (!(error instanceof ResearchWriteError)) throw error;
      // The savepoint has already rolled back catalog materialization and every
      // other mutation. A quota denial is transient: retain an immutable audit
      // entry, but remove the provisional idempotency row so the same key and
      // digest can be evaluated again after retry_after_ms.
      if (error.code === "RATE_LIMITED") {
        const outcome = rateLimitedOutcome("update_content", error);
        await this.#commitTransientUpdateRateLimit(transaction, {
          authorization: input.authorization,
          channel: input.channel,
          command: input.command,
          context: input.context,
          decisionId: input.decisionId,
          evaluation: input.evaluation,
          idempotencyId,
          auditDigests: input.auditDigests,
          now: input.now,
          outcome,
          requestId: input.requestId,
        });
        return outcome;
      }
      const outcome = isPlatformRuleDenial(error)
        ? platformRuleDeniedOutcome("update_content", error)
        : expectedErrorOutcome("update_content", input.evaluation, error);
      await this.#writeActionLog(transaction, {
        action: actionName(input.command.operation),
        actorId: input.authorization.actor_id,
        after: {
          content_id: input.command.contentId,
          error_code: error.code,
          expected_version: input.command.expectedVersion,
        },
        auditDigests: input.auditDigests,
        agentId: input.context.agent.id,
        auditId: this.#newId("audit_id"),
        channel: input.channel,
        credentialId: input.context.credential.id,
        decision: outcome.decision,
        decisionId: input.decisionId,
        errorCode: error.code,
        evaluation: input.evaluation,
        outcome: outcome.status === "denied" ? "denied" : "failed",
        occurredAt: input.now,
        outboxId: null,
        ownerId: input.context.owner.id,
        policy: input.authorization,
        reasonCode: error.code.toLocaleLowerCase("en-US"),
        requestId: input.requestId,
        targetId: input.command.contentId,
        targetType: "content",
      });
      await this.#finalizeIdempotency(
        transaction,
        idempotencyId,
        outcome.status === "denied" ? "denied" : "failed",
        error.statusCode,
        outcome,
        null,
        input.now,
      );
      return outcome;
    }
  }

  #actionAuditDigests(
    inputDigest: Buffer,
    idempotencyKey: string,
    keyVersion: number = this.#actionLogHmacKeyVersion,
  ): ResearchActionAuditDigests {
    if (inputDigest.byteLength !== 32) {
      throw new Error("A research ActionLog requires a SHA-256 input digest.");
    }
    const purposeKey = this.#actionLogHmacKeys.get(keyVersion);
    if (!purposeKey) {
      throw new Error("The ActionLog idempotency digest key version is unavailable.");
    }
    const digest = createHmac("sha256", purposeKey)
      .update(ACTION_LOG_HMAC_VALUE_DOMAIN, "utf8")
      .update(Buffer.from([0]))
      .update(idempotencyKey, "utf8")
      .digest("hex");
    return {
      idempotencyKeyDigest: `hmac-sha256:v${keyVersion}:${digest}`,
      inputDigest: `sha256:${inputDigest.toString("hex")}`,
    };
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
        agent.activated_at as agent_activated_at,
        credential.scopes as credential_scopes,
        credential.policy_ceiling as credential_policy_ceiling,
        credential.policy_ceiling_defaults_version
          as credential_policy_ceiling_defaults_version,
        credential.policy_ceiling_schema_version
          as credential_policy_ceiling_schema_version,
        credential.policy_ceiling_rules as credential_policy_ceiling_rules,
        policy.id as policy_id,
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
        and (
          credential.expires_at is null
          or credential.expires_at > clock_timestamp()
        )
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
    if (
      !row ||
      !(row.agent_activated_at instanceof Date) ||
      Number.isNaN(row.agent_activated_at.valueOf())
    ) {
      throw new ResearchWriteError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The authenticated Agent authority context is no longer valid.",
      );
    }
    return row;
  }

  async #loadApprovedAuthorization(
    transaction: TransactionSql,
    action: FencedPendingAction,
  ): Promise<AuthorizationRow> {
    const rows = await transaction<AuthorizationRow[]>`
      select
        actor.id as actor_id,
        agent.activated_at as agent_activated_at,
        credential.scopes as credential_scopes,
        credential.policy_ceiling as credential_policy_ceiling,
        credential.policy_ceiling_defaults_version
          as credential_policy_ceiling_defaults_version,
        credential.policy_ceiling_schema_version
          as credential_policy_ceiling_schema_version,
        credential.policy_ceiling_rules as credential_policy_ceiling_rules,
        policy.id as policy_id,
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
      where credential.id = ${action.credentialId}
        and credential.owner_id = ${action.ownerId}
        and credential.agent_id = ${action.agentId}
        and credential.revoked_at is null
        and (
          credential.expires_at is null
          or credential.expires_at > clock_timestamp()
        )
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
    if (
      !row ||
      !(row.agent_activated_at instanceof Date) ||
      Number.isNaN(row.agent_activated_at.valueOf())
    ) {
      throw new ResearchWriteError(
        "AUTHORIZATION_CONTEXT_STALE",
        "The approved Agent authority is no longer valid.",
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
      auditDigests: ResearchActionAuditDigests;
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
      auditDigests: input.auditDigests,
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

  async #commitTransientContentRateLimit(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      auditDigests: ResearchActionAuditDigests;
      channel: string;
      command: NewResearchCommand;
      context: AgentCredentialContext;
      decisionId: string;
      error: ResearchWriteError;
      evaluation: AgentOperationEvaluation;
      now: Date;
      requestId: string;
    },
  ): Promise<void> {
    if (
      input.error.code !== "RATE_LIMITED" ||
      !input.error.retryable ||
      input.error.retryAfterMs === null
    ) {
      throw new Error("A transient content denial requires RATE_LIMITED.");
    }
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        error_code: input.error.code,
        ...(input.error.details ?? {}),
        retry_after_ms: input.error.retryAfterMs,
      },
      auditDigests: input.auditDigests,
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
      reasonCode: "rate_limited",
      requestId: input.requestId,
      targetId: intendedTargetId(input.command),
      targetType: input.command.operation === "create_post" ? "community" : "content",
    });
  }

  async #commitTransientUpdateRateLimit(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      auditDigests: ResearchActionAuditDigests;
      channel: string;
      command: NormalizedUpdateContentCommand;
      context: AgentCredentialContext;
      decisionId: string;
      evaluation: AgentOperationEvaluation;
      idempotencyId: string;
      now: Date;
      outcome: ResearchWriteOutcome;
      requestId: string;
    },
  ): Promise<void> {
    const error = input.outcome.error;
    if (
      input.outcome.decision !== "deny" ||
      input.outcome.status !== "denied" ||
      error?.code !== "RATE_LIMITED" ||
      error.retryAfterMs === null
    ) {
      throw new Error("A transient content-update denial requires RATE_LIMITED.");
    }
    const deleted = await transaction<{ id: string }[]>`
      delete from platform.idempotency_records
      where id = ${input.idempotencyId}
        and status = 'in_progress'
      returning id
    `;
    if (deleted.length !== 1) {
      throw new Error(
        "The transient content-update denial could not release its idempotency reservation.",
      );
    }
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        content_id: input.command.contentId,
        error_code: error.code,
        expected_version: input.command.expectedVersion,
        retry_after_ms: error.retryAfterMs,
      },
      auditDigests: input.auditDigests,
      agentId: input.context.agent.id,
      auditId: this.#newId("audit_id"),
      channel: input.channel,
      credentialId: input.context.credential.id,
      decision: "deny",
      decisionId: input.decisionId,
      errorCode: error.code,
      evaluation: input.evaluation,
      outcome: "denied",
      occurredAt: input.now,
      outboxId: null,
      ownerId: input.context.owner.id,
      policy: input.authorization,
      reasonCode: "rate_limited",
      requestId: input.requestId,
      targetId: input.command.contentId,
      targetType: "content",
    });
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
    enforceNewPostCapacity = true,
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
      if (!isReply && enforceNewPostCapacity && admission.rules.maxPostsPerHour === 0) {
        throw new ResearchWriteError(
          "COMMUNITY_RESTRICTED",
          "The Community is not accepting new posts.",
          { details: { community_id: admission.id } },
        );
      }
    }
  }

  #newCommunityAdmissions(
    admissions: readonly CommunityAdmission[],
    newlyAddedCommunityIds: readonly string[],
  ): CommunityAdmission[] {
    if (newlyAddedCommunityIds.length === 0) return [];
    const admissionsById = new Map(
      admissions.map((admission) => [admission.id.toLocaleLowerCase("en-US"), admission]),
    );
    return newlyAddedCommunityIds.map((communityId) => {
      const admission = admissionsById.get(communityId.toLocaleLowerCase("en-US"));
      if (!admission) {
        throw new Error("A new Community placement escaped admission inspection.");
      }
      return admission;
    });
  }

  #enforceNewCommunityPlacementCapacity(
    admissions: readonly CommunityAdmission[],
    newlyAddedCommunityIds: readonly string[],
  ): void {
    for (const admission of this.#newCommunityAdmissions(
      admissions,
      newlyAddedCommunityIds,
    )) {
      if (admission.rules.maxPostsPerHour === 0) {
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
          select content.published_at as admitted_at
          from platform.content_items as content
          where content.author_actor_id = ${actorId}
            and content.kind = 'post'
            and content.primary_community_id = ${communityId}
            and content.published_at > ${now} - interval '1 hour'

          union all

          select additional.created_at as admitted_at
          from platform.content_additional_communities as additional
          join platform.content_items as content on content.id = additional.content_id
          where content.author_actor_id = ${actorId}
            and content.kind = 'post'
            and additional.community_id = ${communityId}
            and additional.created_at > ${now} - interval '1 hour'
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

  async #enforceAgentContentRate(
    transaction: TransactionSql,
    authorization: AuthorizationRow,
    agentId: string,
    operation: "create_post" | "reply_to_content",
    now: Date,
  ): Promise<void> {
    const lockKey = `alphanet:agent-content-rate:${agentId}:${operation}`;
    await transaction`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(${lockKey}, 0)
      )
    `;

    const windowStart = new Date(now.valueOf() - AGENT_CONTENT_RATE_WINDOW_MS);
    const action = actionName(operation);
    const rows = await transaction<AgentContentRateWindow[]>`
      select
        count(*)::integer as succeeded_count,
        min(log.occurred_at) + interval '1 hour' as retry_at
      from platform.action_logs as log
      where log.agent_id = ${agentId}
        and log.action = ${action}
        and log.outcome = 'succeeded'
        and log.occurred_at >= ${windowStart}
    `;
    const window = rows[0];
    if (
      !window ||
      !Number.isInteger(window.succeeded_count) ||
      window.succeeded_count < 0
    ) {
      throw new Error("Agent content quota projection returned invalid data.");
    }

    const isNewAgent =
      now.valueOf() - authorization.agent_activated_at.valueOf() <
      NEW_AGENT_CONTENT_RATE_WINDOW_MS;
    const limit =
      operation === "create_post"
        ? isNewAgent
          ? this.#agentContentRateLimits.newAgentPostsPerHour
          : this.#agentContentRateLimits.establishedPostsPerHour
        : isNewAgent
          ? this.#agentContentRateLimits.newAgentRepliesPerHour
          : this.#agentContentRateLimits.establishedRepliesPerHour;
    if (window.succeeded_count >= limit) {
      const retryAt =
        window.retry_at?.valueOf() ?? now.valueOf() + AGENT_CONTENT_RATE_WINDOW_MS;
      throw new ResearchWriteError(
        "RATE_LIMITED",
        `The Agent ${operation === "create_post" ? "post" : "reply"} limit for this rolling hour has been reached.`,
        {
          details: {
            limit,
            limit_dimension:
              operation === "create_post" ? "agent_post_hour" : "agent_reply_hour",
            new_agent_window: isNewAgent,
            rule_version: AGENT_CONTENT_RATE_RULE_VERSION,
          },
          retryable: true,
          retryAfterMs: Math.max(1, retryAt - now.valueOf()),
        },
      );
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

  async #loadContentUpdateTarget(
    transaction: TransactionSql,
    command: NormalizedUpdateContentCommand,
    actorId: string,
  ): Promise<PreparedContentUpdate> {
    const rows = await transaction<UpdateTargetRow[]>`
      select
        content.author_actor_id,
        content.version::integer as version,
        content.kind,
        content.root_id,
        content.parent_id,
        content.depth,
        content.primary_community_id,
        content.current_revision_id,
        content.lifecycle_state,
        content.distribution_state,
        revision.revision_number::integer as current_revision_number,
        revision.title,
        revision.body_markdown
      from platform.content_items as content
      join platform.content_revisions as revision
        on revision.id = content.current_revision_id
       and revision.content_id = content.id
      where content.id = ${command.contentId}
      limit 1
      for update of content
    `;
    const row = rows[0];
    if (
      !row ||
      row.lifecycle_state !== "published" ||
      row.distribution_state === "hidden"
    ) {
      throw new ResearchWriteError(
        "CONTENT_NOT_FOUND",
        "The ContentItem is unavailable.",
      );
    }
    if (row.author_actor_id !== actorId) {
      throw new ResearchWriteError(
        "NOT_CONTENT_AUTHOR",
        "Only the publishing Agent can update this ContentItem.",
      );
    }
    if (row.version !== command.expectedVersion) {
      throw new ResearchWriteError(
        "VERSION_CONFLICT",
        "The ContentItem changed after the requested base version.",
        {
          details: {
            current_version: row.version,
            expected_version: command.expectedVersion,
          },
        },
      );
    }

    if (
      row.kind === "reply" &&
      (command.patch.title !== undefined ||
        command.patch.additionalCommunityIds !== undefined ||
        command.patch.symbols !== undefined ||
        command.patch.topics !== undefined)
    ) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "Replies can update only body, sources, and references.",
        { details: { reason_code: "REPLY_FIELD_IMMUTABLE" } },
      );
    }

    const additionalRows = await transaction<CurrentAdditionalCommunityRow[]>`
      select additional.community_id, additional.created_at
      from platform.content_additional_communities as additional
      where additional.content_id = ${row.kind === "post" ? row.root_id : command.contentId}
      order by additional.position
    `;
    const symbolRows = await transaction<{ value: string }[]>`
      select symbol.ticker::text as value
      from platform.content_symbols as content_symbol
      join platform.symbols as symbol on symbol.id = content_symbol.symbol_id
      where content_symbol.content_id = ${command.contentId}
      order by content_symbol.position
    `;
    const topicRows = await transaction<{ value: string }[]>`
      select topic.slug::text as value
      from platform.content_topics as content_topic
      join platform.topics as topic on topic.id = content_topic.topic_id
      where content_topic.content_id = ${command.contentId}
      order by content_topic.position
    `;
    const sourceRows = await transaction<CurrentSourceRow[]>`
      select source.url, source.title, source.description
      from platform.source_links as source
      where source.content_id = ${command.contentId}
        and source.removed_revision_id is null
      order by source.position
    `;
    const referenceRows = await transaction<CurrentReferenceRow[]>`
      select
        relation.to_content_id as target_content_id,
        relation.relation_type
      from platform.content_relations as relation
      where relation.from_content_id = ${command.contentId}
        and relation.removed_revision_id is null
      order by relation.position
    `;
    const mentionRows = await transaction<{ mentioned_actor_id: string }[]>`
      select mention.mentioned_actor_id
      from platform.mentions as mention
      where mention.revision_id = ${row.current_revision_id}
      order by mention.position
    `;

    const currentSources = sourceRows.map((source) => ({
      url: source.url,
      ...(source.title === null ? {} : { title: source.title }),
      ...(source.description === null ? {} : { description: source.description }),
    }));
    const currentReferences = referenceRows.map((reference) => ({
      targetContentId: reference.target_content_id,
      relationType: reference.relation_type,
    }));
    const currentAdditionalCommunityIds = additionalRows.map(
      (additional) => additional.community_id,
    );
    const currentSymbols = symbolRows.map((symbol) => symbol.value);
    const currentTopics = topicRows.map((topic) => topic.value);
    const additionalCommunityIds =
      command.patch.additionalCommunityIds ?? currentAdditionalCommunityIds;
    const symbols = command.patch.symbols ?? currentSymbols;
    const topics = command.patch.topics ?? currentTopics;
    const sourceLinks = command.patch.sourceLinks ?? currentSources;
    const references = command.patch.references ?? currentReferences;
    const title = command.patch.title ?? row.title;
    const bodyMarkdown = command.patch.bodyMarkdown ?? row.body_markdown;

    if (references.some((reference) => reference.targetContentId === command.contentId)) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "Content cannot reference itself.",
        { details: { field: "references", reason_code: "SELF_REFERENCE" } },
      );
    }

    if (row.kind === "post") {
      if (title === null || unicodeLength(title) < 5 || unicodeLength(title) > 200) {
        throw new ResearchWriteError(
          "VALIDATION_ERROR",
          "Post titles must contain 5 through 200 Unicode characters.",
          { details: { field: "title" } },
        );
      }
      if (
        row.primary_community_id === null ||
        additionalCommunityIds.includes(row.primary_community_id)
      ) {
        throw new ResearchWriteError(
          "VALIDATION_ERROR",
          "The primary Community cannot be changed or duplicated as additional.",
          { details: { field: "additional_community_ids" } },
        );
      }
    }
    const bodyLimit = row.kind === "post" ? 100_000 : 20_000;
    if (
      bodyMarkdown.trim().length === 0 ||
      unicodeLength(bodyMarkdown) > bodyLimit ||
      Buffer.byteLength(bodyMarkdown, "utf8") > BODY_BYTES_LIMIT
    ) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "The normalized Markdown body is outside the content-kind limit.",
        { details: { field: "body_markdown" } },
      );
    }

    const equal = (left: unknown, right: unknown): boolean =>
      JSON.stringify(left) === JSON.stringify(right);
    const changedGroups: string[] = [];
    if (title !== row.title) changedGroups.push("title");
    if (bodyMarkdown !== row.body_markdown) changedGroups.push("body_markdown");
    if (!equal(sourceLinks, currentSources)) changedGroups.push("source_links");
    if (!equal(references, currentReferences)) changedGroups.push("references");
    if (!equal(additionalCommunityIds, currentAdditionalCommunityIds)) {
      changedGroups.push("additional_community_ids");
    }
    if (!equal(symbols, currentSymbols)) changedGroups.push("symbols");
    if (!equal(topics, currentTopics)) changedGroups.push("topics");
    if (changedGroups.length === 0) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "The update patch does not make a material change.",
        { details: { reason_code: "NO_MATERIAL_CHANGE" } },
      );
    }
    const revisionChanged = changedGroups.some((group) =>
      ["title", "body_markdown", "source_links", "references"].includes(group),
    );
    if (!revisionChanged && command.editSummary !== undefined) {
      throw new ResearchWriteError(
        "VALIDATION_ERROR",
        "An edit summary requires a new immutable Revision.",
        { details: { field: "edit_summary" } },
      );
    }

    let communityIds: string[];
    if (row.kind === "post") {
      communityIds = [row.primary_community_id!, ...additionalCommunityIds];
    } else {
      const roots = await transaction<{ primary_community_id: string }[]>`
        select root.primary_community_id
        from platform.content_items as root
        where root.id = ${row.root_id}
          and root.kind = 'post'
          and root.lifecycle_state = 'published'
          and root.distribution_state <> 'hidden'
        limit 1
        for share
      `;
      const root = roots[0];
      if (!root) {
        throw new ResearchWriteError(
          "CONTENT_NOT_FOUND",
          "The reply discussion root is unavailable.",
        );
      }
      const rootAdditional = await transaction<{ community_id: string }[]>`
        select additional.community_id
        from platform.content_additional_communities as additional
        where additional.content_id = ${row.root_id}
        order by additional.position
      `;
      communityIds = [
        root.primary_community_id,
        ...rootAdditional.map((item) => item.community_id),
      ];
    }

    return {
      additionalCommunityIds,
      additionalCommunityCreatedAtById: new Map(
        additionalRows.map((additional) => [
          additional.community_id,
          additional.created_at,
        ]),
      ),
      bodyMarkdown,
      changedGroups,
      classificationChanged: changedGroups.some((group) =>
        ["additional_community_ids", "symbols", "topics"].includes(group),
      ),
      communityIds,
      contentId: command.contentId,
      currentBodyMarkdown: row.body_markdown,
      currentCommunityIds:
        row.kind === "post"
          ? [row.primary_community_id!, ...currentAdditionalCommunityIds]
          : [...communityIds],
      currentMentionActorIds: mentionRows.map((mention) => mention.mentioned_actor_id),
      currentReferences,
      currentRevisionId: row.current_revision_id,
      currentRevisionNumber: row.current_revision_number,
      currentSources,
      currentTitle: row.title,
      currentVersion: row.version,
      kind: row.kind,
      newlyAddedCommunityIds: additionalCommunityIds.filter(
        (communityId) => !currentAdditionalCommunityIds.includes(communityId),
      ),
      primaryCommunityId: row.primary_community_id,
      references,
      revisionChanged,
      rootContentId: row.root_id,
      sourceLinks,
      symbols,
      title,
      topics,
    };
  }

  async #enforceUpdateRates(
    transaction: TransactionSql,
    actorId: string,
    contentId: string,
    now: Date,
  ): Promise<void> {
    const lockKeys = [
      `alphanet:content-update-rate:actor:${actorId}`,
      `alphanet:content-update-rate:content:${contentId}`,
    ].sort();
    for (const lockKey of lockKeys) {
      await transaction`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${lockKey}, 0)
        )
      `;
    }
    const rows = await transaction<
      {
        actor_count: number;
        actor_retry_at: Date | null;
        content_count: number;
        content_retry_at: Date | null;
      }[]
    >`
      select
        count(*) filter (where log.actor_id = ${actorId})::integer as actor_count,
        min(log.occurred_at) filter (where log.actor_id = ${actorId})
          + interval '1 hour' as actor_retry_at,
        count(*) filter (where log.target_id = ${contentId})::integer as content_count,
        min(log.occurred_at) filter (where log.target_id = ${contentId})
          + interval '1 hour' as content_retry_at
      from platform.action_logs as log
      where log.event_class = 'domain_write'
        and log.action = 'content.update_content'
        and log.outcome = 'succeeded'
        and log.occurred_at > ${now} - interval '1 hour'
        and (log.actor_id = ${actorId} or log.target_id = ${contentId})
    `;
    const window = rows[0];
    if (!window) throw new Error("Content-update quota query returned no aggregate row.");
    const actorLimited = window.actor_count >= 30;
    const contentLimited = window.content_count >= 10;
    if (actorLimited || contentLimited) {
      const retryAt = actorLimited ? window.actor_retry_at : window.content_retry_at;
      throw new ResearchWriteError(
        "RATE_LIMITED",
        "The content update rate limit has been reached.",
        {
          details: {
            limit: actorLimited ? 30 : 10,
            limit_dimension: actorLimited ? "agent_updates" : "content_updates",
          },
          retryable: true,
          retryAfterMs: Math.max(
            1,
            (retryAt?.valueOf() ?? now.valueOf() + 60_000) - now.valueOf(),
          ),
        },
      );
    }
  }

  async #persistContentUpdate(
    transaction: TransactionSql,
    input: {
      actorId: string;
      command: NormalizedUpdateContentCommand;
      facts: ResolvedWriteFacts;
      now: Date;
      prepared: PreparedContentUpdate;
    },
  ): Promise<PersistedContentUpdate> {
    const newVersion = input.prepared.currentVersion + 1;
    const revisionId = input.prepared.revisionChanged ? this.#newId("revision_id") : null;
    const revisionNumber = input.prepared.currentRevisionNumber + 1;

    if (revisionId !== null) {
      const revision = prepareRevisionFields({
        bodyMarkdown: input.prepared.bodyMarkdown,
        references: input.prepared.references,
        sourceLinks: input.prepared.sourceLinks,
        symbols: input.prepared.symbols,
        title: input.prepared.title,
        topics: input.prepared.topics,
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
          created_at,
          source_version,
          content_hash,
          public_node_serialized_bytes
        )
        values (
          ${revisionId},
          ${input.prepared.contentId},
          ${revisionNumber},
          ${input.prepared.title},
          ${input.prepared.bodyMarkdown},
          ${revision.bodyPlainText},
          ${input.command.editSummary ?? null},
          ${input.actorId},
          ${input.now},
          ${newVersion},
          ${revision.contentHash},
          ${revision.publicNodeBytes}
        )
      `;

      if (input.prepared.changedGroups.includes("source_links")) {
        await transaction`
          update platform.source_links
          set removed_revision_id = ${revisionId}
          where content_id = ${input.prepared.contentId}
            and removed_revision_id is null
        `;
        for (const [index, source] of input.prepared.sourceLinks.entries()) {
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
              ${input.prepared.contentId},
              ${index + 1},
              ${source.url},
              ${createHash("sha256").update(source.url, "utf8").digest()},
              ${source.title ?? null},
              ${source.description ?? null},
              ${revisionId},
              ${input.actorId},
              ${input.now}
            )
          `;
        }
      }

      if (input.prepared.changedGroups.includes("references")) {
        await transaction`
          update platform.content_relations
          set removed_revision_id = ${revisionId}
          where from_content_id = ${input.prepared.contentId}
            and removed_revision_id is null
        `;
        for (const [index, reference] of input.prepared.references.entries()) {
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
              ${input.prepared.contentId},
              ${reference.targetContentId},
              ${index + 1},
              ${reference.relationType},
              ${revisionId},
              ${input.now}
            )
          `;
        }
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
            ${input.prepared.contentId},
            ${revisionNumber},
            ${mentionedActorId},
            ${index + 1},
            ${input.now}
          )
        `;
      }
    }

    if (input.prepared.changedGroups.includes("additional_community_ids")) {
      await transaction`
        delete from platform.content_additional_communities
        where content_id = ${input.prepared.contentId}
      `;
      for (const [
        index,
        communityId,
      ] of input.prepared.additionalCommunityIds.entries()) {
        await transaction`
          insert into platform.content_additional_communities (
            content_id,
            community_id,
            position,
            created_at
          )
          values (
            ${input.prepared.contentId},
            ${communityId},
            ${index + 1},
            ${input.prepared.additionalCommunityCreatedAtById.get(communityId) ?? input.now}
          )
        `;
      }
    }
    if (input.prepared.changedGroups.includes("symbols")) {
      await transaction`
        delete from platform.content_symbols
        where content_id = ${input.prepared.contentId}
      `;
      for (const [index, symbolId] of input.facts.symbolIds.entries()) {
        await transaction`
          insert into platform.content_symbols (
            content_id,
            symbol_id,
            position,
            created_at
          )
          values (${input.prepared.contentId}, ${symbolId}, ${index + 1}, ${input.now})
        `;
      }
    }
    if (input.prepared.changedGroups.includes("topics")) {
      await transaction`
        delete from platform.content_topics
        where content_id = ${input.prepared.contentId}
      `;
      for (const [index, topicId] of input.facts.topicIds.entries()) {
        await transaction`
          insert into platform.content_topics (
            content_id,
            topic_id,
            position,
            created_at
          )
          values (${input.prepared.contentId}, ${topicId}, ${index + 1}, ${input.now})
        `;
      }
    }

    const updated = await transaction<{ id: string }[]>`
      update platform.content_items
      set version = ${newVersion},
          current_revision_id = ${revisionId ?? input.prepared.currentRevisionId}
      where id = ${input.prepared.contentId}
        and author_actor_id = ${input.actorId}
        and version = ${input.prepared.currentVersion}
        and lifecycle_state = 'published'
      returning id
    `;
    if (!updated[0]) {
      throw new ResearchWriteError(
        "VERSION_CONFLICT",
        "The ContentItem changed before the update could commit.",
      );
    }

    const { id: outboxId } = await appendOutboxEvent(transaction, {
      aggregateId: input.prepared.contentId,
      aggregateType: "content",
      eventType: "content.revised",
      eventVersion: 1,
      occurredAt: input.now,
      payload: {
        actor_id: input.actorId,
        changed_groups: input.prepared.changedGroups,
        content_id: input.prepared.contentId,
        resource_version: newVersion,
        revision_id: revisionId,
        root_content_id: input.prepared.rootContentId,
      },
    });
    return {
      contentId: input.prepared.contentId,
      outboxId,
      result: {
        contentId: input.prepared.contentId,
        resourceVersion: newVersion,
        revisionId,
      },
      rootContentId: input.prepared.rootContentId,
    };
  }

  async #resolveWriteFacts(
    transaction: TransactionSql,
    command: ResearchFactsInput,
    handles: string[],
  ): Promise<ResolvedWriteFacts> {
    const symbolIds: string[] = [];
    if (command.symbols.length > 0) {
      const rows = await transaction<ClassificationRow[]>`
        select symbol.id, symbol.ticker::text as value
        from platform.symbols as symbol
        where symbol.ticker::text = any(${transaction.array([...command.symbols])}::text[])
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
        where topic.slug::text = any(${transaction.array([...command.topics])}::text[])
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
    }

    return { mentionActorIds, referenceTargetIds, symbolIds, topicIds };
  }

  async #createPendingAction(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      auditDigests: ResearchActionAuditDigests;
      channel: string;
      command: NormalizedResearchCommand;
      context: AgentCredentialContext;
      decisionId: string;
      digestBytes: Buffer;
      digestText: string;
      evaluation: AgentOperationEvaluation;
      idempotencyId: string;
      idempotencyKey: string;
      mentionActorIds: string[];
      now: Date;
      principalScopeKey: string;
      requestId: string;
      updateBaseline?: FrozenUpdateContentBaseline | undefined;
    },
  ): Promise<ResearchWriteOutcome> {
    const actionId = this.#newId("pending_action_id");
    const auditId = this.#newId("audit_id");
    const expiresAt = new Date(input.now.valueOf() + this.#pendingActionTtlMs);
    const approvalSummary =
      input.command.operation === "create_post"
        ? `Create one post in ${1 + input.command.additionalCommunityIds.length} ${input.command.additionalCommunityIds.length === 0 ? "Community" : "Communities"}.`
        : input.command.operation === "reply_to_content"
          ? "Create one reply in an existing discussion."
          : `Update one ContentItem from version ${input.command.expectedVersion}.`;
    const commandWithFrozenMentions = freezeResearchCommandMentionActors(
      input.command,
      input.mentionActorIds,
    );
    let frozenCommand: NormalizedResearchCommand = commandWithFrozenMentions;
    if (commandWithFrozenMentions.operation === "update_content") {
      if (!input.updateBaseline) {
        throw new Error("An update PendingAction requires a frozen baseline.");
      }
      frozenCommand = freezeUpdateContentBaseline(
        commandWithFrozenMentions,
        input.updateBaseline,
      );
    } else if (input.updateBaseline !== undefined) {
      throw new Error("Only update PendingActions can carry a frozen baseline.");
    }
    const encrypted = encryptPendingCommand(
      frozenCommand,
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

    const { id: outboxId } = await appendOutboxEvent(transaction, {
      aggregateId: actionId,
      aggregateType: "pending_action",
      eventType: "action.pending_approval",
      eventVersion: 1,
      occurredAt: input.now,
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
      auditDigests: input.auditDigests,
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
        expected_version,
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
        ${input.command.operation === "update_content" ? input.command.expectedVersion : null},
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
        ...(input.command.operation === "update_content"
          ? { expectedVersion: input.command.expectedVersion }
          : {}),
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
          pending_action_id = ${actionId},
          resource_id = null,
          updated_at = ${input.now}
      where id = ${input.idempotencyId}
        and status = 'in_progress'
        and terminal_at is null
    `;
    return outcome;
  }

  async #insertResearchContent(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      command: NewResearchCommand;
      facts: ResolvedWriteFacts;
      now: Date;
      preparedRevision: PreparedRevision;
      replyTarget: ReplyTarget | null;
    },
  ): Promise<PersistedResearchContent> {
    const contentId = this.#newId("content_id");
    const revisionId = this.#newId("revision_id");
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
    const { id: outboxId } = await appendOutboxEvent(transaction, {
      aggregateId: contentId,
      aggregateType: "content",
      eventType: isPost ? "content.published" : "content.reply",
      eventVersion: 1,
      occurredAt: input.now,
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

    const result: CreatePostResearchResult | ReplyResearchResult = isPost
      ? { contentId, resourceVersion: 1, revisionId }
      : {
          contentId,
          resourceVersion: 1,
          revisionId,
          rootContentId: rootId,
        };
    return {
      contentId,
      outboxId,
      result,
      revisionId,
      rootContentId: rootId,
    };
  }

  async #commitAutonomousContent(
    transaction: TransactionSql,
    input: {
      authorization: AuthorizationRow;
      auditDigests: ResearchActionAuditDigests;
      channel: string;
      command: NewResearchCommand;
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
    const persisted = await this.#insertResearchContent(transaction, {
      authorization: input.authorization,
      command: input.command,
      facts: input.facts,
      now: input.now,
      preparedRevision: input.preparedRevision,
      replyTarget: input.replyTarget,
    });
    const auditId = this.#newId("audit_id");
    await this.#writeActionLog(transaction, {
      action: actionName(input.command.operation),
      actorId: input.authorization.actor_id,
      after: {
        content_id: persisted.contentId,
        idempotency_record_id: input.idempotencyId,
        resource_version: 1,
        revision_id: persisted.revisionId,
        root_content_id: persisted.rootContentId,
      },
      auditDigests: input.auditDigests,
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
      outboxId: persisted.outboxId,
      ownerId: input.context.owner.id,
      policy: input.authorization,
      requestId: input.requestId,
      targetId: persisted.contentId,
      targetType: "content",
    });

    const outcome: ResearchWriteOutcome = {
      decision: "allow",
      error: null,
      operation: input.command.operation,
      pendingAction: null,
      replayed: false,
      result: persisted.result,
      status: "succeeded",
    };
    await this.#finalizeIdempotency(
      transaction,
      input.idempotencyId,
      "succeeded",
      201,
      outcome,
      persisted.contentId,
      input.now,
    );
    return outcome;
  }

  async #writeActionLog(
    transaction: TransactionSql,
    event: {
      action: string;
      actorId: string;
      after: postgres.JSONValue;
      auditDigests: ResearchActionAuditDigests;
      agentId: string;
      approvalMethod?: "owner_approval" | "policy_auto" | undefined;
      approvedByOwnerId?: string | null | undefined;
      auditId: string;
      authenticationAssurance?: string | undefined;
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
      policySnapshotOverride?: postgres.JSONValue | undefined;
      reasonCode?: string | undefined;
      requestId: string;
      targetId: string;
      targetType: "community" | "content";
    },
  ): Promise<void> {
    if (
      !isRecord(event.after) ||
      Object.hasOwn(event.after, "input_digest") ||
      Object.hasOwn(event.after, "idempotency_key_digest")
    ) {
      throw new Error("Research ActionLog after_state has an invalid audit shape.");
    }
    const afterState = {
      ...event.after,
      idempotency_key_digest: event.auditDigests.idempotencyKeyDigest,
      input_digest: event.auditDigests.inputDigest,
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
        ${event.auditId},
        'domain_write',
        ${event.occurredAt},
        ${event.actorId},
        'agent',
        ${event.ownerId},
        ${event.agentId},
        ${event.credentialId},
        ${event.channel},
        ${event.approvalMethod ?? (event.decision === "allow" ? "policy_auto" : null)},
        ${event.approvedByOwnerId ?? null},
        ${event.authenticationAssurance ?? "agent_credential"},
        ${transaction.json(
          event.policySnapshotOverride ??
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
        ${transaction.json(afterState)},
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
  switch (operation) {
    case "create_post":
      return "content.create_post";
    case "reply_to_content":
      return "content.reply_to_content";
    case "update_content":
      return "content.update_content";
  }
}

function intendedTargetId(command: NormalizedResearchCommand): string {
  switch (command.operation) {
    case "create_post":
      return command.primaryCommunityId;
    case "reply_to_content":
      return command.parentContentId;
    case "update_content":
      return command.contentId;
  }
}
