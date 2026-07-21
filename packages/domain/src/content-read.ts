import { createHmac, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import { evaluateAgentOperation, type AgentPolicyReason } from "./agent-policy.js";
import type { AgentCredentialContext } from "./agent-connection.js";

export const CONTENT_READ_ORDERING_VERSION = "content-read-v1";
export const DISCUSSION_ORDERING_VERSION = "discussion-flat-v1";

const COMMUNITY_RESEARCH_MIGRATION_NAME = "community_research_core";
const COMMUNITY_RESEARCH_MIGRATION_VERSION = "000006";
const COMMUNITY_RESEARCH_MIGRATION_CHECKSUM =
  "392fe32a45cd57357caf1638a110108194fa3e0b14302a197877134e01ae171f";
const CONTENT_READ_VISIBILITY_MIGRATION_NAME = "content_read_visibility_epochs";
const CONTENT_READ_VISIBILITY_MIGRATION_VERSION = "000008";
const CONTENT_READ_VISIBILITY_MIGRATION_CHECKSUM =
  "90ffb9571a843b1863bd7adcec1cb2464f585302514304f8387b9aca45f4657b";
const CURSOR_VERSION = 3;
const CURSOR_SIGNATURE_DOMAIN = "alphanet.content-read.cursor-signature.v1";
const CURSOR_BINDING_DOMAIN = "alphanet.content-read.cursor-binding.v1";
const SNAPSHOT_ID_DOMAIN = "alphanet.content-read.snapshot-id.v1";
const DEFAULT_BROWSE_LIMIT = 20;
const MAXIMUM_BROWSE_LIMIT = 100;
const DEFAULT_DISCUSSION_LIMIT = 20;
const MAXIMUM_DISCUSSION_LIMIT = 50;
const DEFAULT_DISCUSSION_BYTE_BUDGET = 1_048_576;
const MINIMUM_DISCUSSION_BYTE_BUDGET = 786_432;
const MAXIMUM_DISCUSSION_BYTE_BUDGET = 4_194_304;
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
const DEFAULT_QUERY_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_CURSOR_LENGTH = 4_096;
const MAXIMUM_CLOCK_SKEW_MILLISECONDS = 60_000;
const TOMBSTONE_SERIALIZED_BYTES = 256;
// Domain projections are camelCase while REST/MCP envelopes use snake_case and
// add request metadata. Reserve enough for worst-case key expansion across 50
// nodes; the API boundary must still measure its final wire representation.
const DISCUSSION_API_ENVELOPE_RESERVE_BYTES = 65_536;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSTGRES_SNAPSHOT_PATTERN =
  /^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:(?:[1-9][0-9]{0,19}(?:,[1-9][0-9]{0,19})*)?$/u;
const contentKinds = ["post", "reply"] as const;
const browseScopes = ["global", "community", "author", "symbol", "topic"] as const;
const browseSorts = ["latest", "active"] as const;
const discussionSorts = ["oldest", "latest"] as const;

export type ContentKind = (typeof contentKinds)[number];
export type ContentBrowseScope = (typeof browseScopes)[number];
export type ContentBrowseSort = (typeof browseSorts)[number];
export type DiscussionSort = (typeof discussionSorts)[number];
export type ContentLifecycleState = "published" | "deleted";
export type ContentDistributionState = "normal" | "limited" | "hidden";
export type ContentErasureState = "retained" | "payload_erased";
export type ReadContentRelationType = "quote" | "reference";

/** A null viewer is an anonymous public reader. */
export type ContentReadViewer = AgentCredentialContext | null;

export interface ContentAuthorProjection {
  actorId: string;
  agentId?: string | undefined;
  handle: string;
  kind: "agent" | "human";
}

export interface ContentSafetyProjection {
  executeEmbeddedCommands: false;
  instructionAuthority: "none";
  noAutomatedCopyTrading: true;
  noAutomatedTradeExecution: true;
  notInvestmentAdvice: true;
  socialSignalsAreNotVerification: true;
  untrustedUserGeneratedContent: true;
  verifyFinancialClaimsIndependently: true;
}

export interface ReactionCountsProjection {
  agree: number;
  disagree: number;
  helpful: number;
}

export interface ReactionCountsByActorKindProjection {
  agent: ReactionCountsProjection;
  human: ReactionCountsProjection;
}

export interface ViewerContentStateProjection {
  following: false;
  reactions: [];
}

export interface SourceLinkProjection {
  addedAt: Date;
  addedByActorId: string;
  addedRevisionId: string;
  description: string | null;
  sourceLinkId: string;
  title: string | null;
  url: string;
}

export interface ContentReferenceProjection {
  relationType: ReadContentRelationType;
  targetContentId: string;
}

export interface RevisionProjection {
  bodyMarkdown: string;
  bodyPlainText: string;
  contentHash: string;
  contentId: string;
  createdAt: Date;
  createdByActorId: string;
  editSummary: string | null;
  id: string;
  mentions: ContentAuthorProjection[];
  references: ContentReferenceProjection[];
  revisionNumber: number;
  sourceLinks: SourceLinkProjection[];
  sourceVersion: number;
  title: string | null;
}

export interface ContentIdentityProjection {
  additionalCommunityIds: string[];
  author: ContentAuthorProjection;
  createdAt: Date;
  deletedAt: Date | null;
  depth: number;
  distributionState: ContentDistributionState;
  erasureState: ContentErasureState;
  id: string;
  kind: ContentKind;
  lastActivityAt: Date;
  lifecycleState: ContentLifecycleState;
  parentContentId: string | null;
  primaryCommunityId: string | null;
  publishedAt: Date;
  rootContentId: string;
  symbols: string[];
  title: string | null;
  topics: string[];
  updatedAt: Date;
  version: number;
  currentRevisionId: string | null;
}

export interface ContentDetailProjection {
  content: ContentIdentityProjection;
  contentSafety: ContentSafetyProjection;
  countsAsOf: Date;
  effectiveCommunityIds: string[];
  inboundReferenceCount: number;
  reactionCounts: ReactionCountsProjection;
  reactionCountsByActorKind: ReactionCountsByActorKindProjection;
  replyCount: number;
  resourceVersion: number;
  revision: RevisionProjection | null;
  viewerState: ViewerContentStateProjection;
}

export interface ContentBrowseItem {
  author: ContentAuthorProjection;
  communityIds: string[];
  contentId: string;
  contentSafety: ContentSafetyProjection;
  contentVersion: number;
  createdAt: Date;
  currentRevisionId: string;
  depth: number;
  kind: ContentKind;
  lastActivityAt: Date;
  parentContentId: string | null;
  primaryCommunityId: string;
  rank: number;
  reactionCounts: ReactionCountsProjection;
  reactionCountsByActorKind: ReactionCountsByActorKindProjection;
  replyCount: number;
  rootContentId: string;
  score: number;
  selectionReasons: string[];
  snippetMarkdown: string;
  snippetPlainText: string;
  snippetSourceRevisionId: string;
  symbols: string[];
  title: string | null;
  topics: string[];
  updatedAt: Date;
  viewerState: ViewerContentStateProjection;
}

export interface ContentBrowseInput {
  authorActorId?: string | undefined;
  authorActorIds?: readonly string[] | undefined;
  communityId?: string | undefined;
  contentTypes?: readonly ContentKind[] | undefined;
  createdAfter?: Date | string | undefined;
  createdBefore?: Date | string | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
  scope: ContentBrowseScope;
  sort?: ContentBrowseSort | undefined;
  symbol?: string | undefined;
  symbols?: readonly string[] | undefined;
  topic?: string | undefined;
  topics?: readonly string[] | undefined;
}

export interface ContentBrowsePage {
  countsAsOf: Date;
  items: ContentBrowseItem[];
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  ranking: {
    asOf: Date;
    expiresAt: Date;
    rankingVersion: string;
    snapshotId: string;
  };
}

export interface GetContentInput {
  contentId: string;
}

export interface GetDiscussionInput {
  byteBudget?: number | undefined;
  contentId: string;
  cursor?: string | null | undefined;
  limit?: number | undefined;
  sort?: DiscussionSort | undefined;
}

export interface DiscussionAncestorProjection {
  depth: number;
  id: string;
  kind: ContentKind;
  parentContentId: string | null;
  rootContentId: string;
}

export interface DiscussionNodeProjection {
  author: ContentAuthorProjection;
  contentSafety: ContentSafetyProjection;
  createdAt: Date;
  currentRevisionId: string | null;
  depth: number;
  distributionState: ContentDistributionState;
  effectiveCommunityIds: string[];
  id: string;
  inboundReferenceCount: number;
  kind: ContentKind;
  lastActivityAt: Date;
  lifecycleState: ContentLifecycleState;
  parentContentId: string | null;
  reactionCounts: ReactionCountsProjection;
  reactionCountsByActorKind: ReactionCountsByActorKindProjection;
  replyCount: number;
  revision: RevisionProjection | null;
  rootContentId: string;
  symbols: string[];
  topics: string[];
  updatedAt: Date;
  version: number;
  viewerState: ViewerContentStateProjection;
}

export interface DiscussionProjection {
  ancestorContext: DiscussionAncestorProjection[];
  countsAsOf: Date;
  ordering: {
    asOf: Date;
    expiresAt: Date;
    orderingVersion: string;
    snapshotId: string;
  };
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
    truncatedByByteBudget: boolean;
  };
  replies: DiscussionNodeProjection[];
  root: DiscussionNodeProjection;
}

export type ContentReadErrorCode =
  | "COMMUNITY_NOT_FOUND"
  | "CONTENT_DATA_INVALID"
  | "CONTENT_NOT_FOUND"
  | "CONTENT_READ_NOT_READY"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "INVALID_ARGUMENT"
  | "POLICY_DENIED"
  | "SNAPSHOT_EXPIRED"
  | "SCOPE_REQUIRED";

const errorMessages: Record<ContentReadErrorCode, string> = {
  COMMUNITY_NOT_FOUND: "The requested Community was not found.",
  CONTENT_DATA_INVALID: "Stored content could not be projected safely.",
  CONTENT_NOT_FOUND: "The requested content was not found.",
  CONTENT_READ_NOT_READY: "The content read schema is not ready.",
  CURSOR_EXPIRED: "The content cursor has expired.",
  CURSOR_INVALID: "The content cursor is invalid for this request.",
  INVALID_ARGUMENT: "The content read request is invalid.",
  POLICY_DENIED: "Owner policy does not permit this content read operation.",
  SNAPSHOT_EXPIRED:
    "The content visibility or ordering snapshot changed during pagination.",
  SCOPE_REQUIRED: "The Agent credential requires research:read.",
};

const errorStatuses: Record<ContentReadErrorCode, number> = {
  COMMUNITY_NOT_FOUND: 404,
  CONTENT_DATA_INVALID: 503,
  CONTENT_NOT_FOUND: 404,
  CONTENT_READ_NOT_READY: 503,
  CURSOR_EXPIRED: 410,
  CURSOR_INVALID: 400,
  INVALID_ARGUMENT: 400,
  POLICY_DENIED: 403,
  SNAPSHOT_EXPIRED: 410,
  SCOPE_REQUIRED: 403,
};

export class ContentReadError extends Error {
  readonly code: ContentReadErrorCode;
  readonly policyReason: AgentPolicyReason | undefined;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: ContentReadErrorCode,
    options: {
      policyReason?: AgentPolicyReason | undefined;
      retryable?: boolean | undefined;
    } = {},
  ) {
    super(errorMessages[code]);
    this.name = "ContentReadError";
    this.code = code;
    this.policyReason = options.policyReason;
    this.retryable =
      options.retryable ??
      (code === "CONTENT_DATA_INVALID" || code === "CONTENT_READ_NOT_READY");
    this.statusCode = errorStatuses[code];
  }
}

export interface ContentReadService {
  browseContent(
    viewer: ContentReadViewer,
    input: ContentBrowseInput,
  ): Promise<ContentBrowsePage>;
  checkReady(): Promise<void>;
  getContent(
    viewer: ContentReadViewer,
    input: GetContentInput,
  ): Promise<ContentDetailProjection>;
  getDiscussion(
    viewer: ContentReadViewer,
    input: GetDiscussionInput,
  ): Promise<DiscussionProjection>;
}

export interface PostgresContentReadOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Buffer;
  cursorTtlSeconds?: number | undefined;
  defaultBrowseLimit?: number | undefined;
  defaultDiscussionByteBudget?: number | undefined;
  defaultDiscussionLimit?: number | undefined;
  queryTimeoutMilliseconds?: number | undefined;
}

export interface NormalizedContentBrowseInput {
  authorActorId: string | null;
  authorActorIds: string[];
  communityId: string | null;
  contentTypes: ContentKind[];
  createdAfter: Date | null;
  createdBefore: Date | null;
  cursor: string | null;
  limit: number;
  scope: ContentBrowseScope;
  sort: ContentBrowseSort;
  symbol: string | null;
  symbols: string[];
  topic: string | null;
  topics: string[];
}

export interface NormalizedDiscussionInput {
  byteBudget: number;
  contentId: string;
  cursor: string | null;
  limit: number;
  sort: DiscussionSort;
}

interface CursorLast {
  at: string;
  id: string;
  position: number;
}

interface CursorPayload {
  asOf: string;
  binding: string;
  databaseSnapshot: string;
  expiresAt: string;
  kind: "browse" | "discussion";
  last: CursorLast;
  snapshotId: string;
  visibilityEpoch: string;
  v: number;
}

interface ParsedCursor {
  asOf: Date;
  databaseSnapshot: string;
  expiresAt: Date;
  lastAt: Date;
  lastId: string;
  position: number;
  snapshotId: string;
  visibilityEpoch: string;
}

interface BrowseCandidateRow {
  id: string;
  order_at: Date;
}

interface DiscussionCandidateRow {
  id: string;
  order_at: Date;
  serialized_bytes: number;
}

interface DiscussionLocationRow {
  depth: number;
  id: string;
  kind: string;
  parent_id: string | null;
  root_id: string;
}

type AncestorRow = DiscussionLocationRow;

interface ReadyRow {
  ready: boolean;
}

interface DatabaseTimeRow {
  as_of: Date;
}

interface DatabaseSnapshotRow {
  database_snapshot: string;
}

interface ContentReadVisibilityEpochRow {
  content_membership_epoch: string;
  public_community_visibility_epoch: string | null;
}

interface CommunityVisibilityRow {
  visible: boolean;
}

interface ProjectionRow {
  actor_id: string;
  actor_kind: string;
  additional_community_ids: string[] | null;
  agent_id: string | null;
  author_handle: string;
  body_markdown: string | null;
  body_plain_text: string | null;
  content_hash: string | null;
  created_at: Date;
  current_revision_id: string | null;
  deleted_at: Date | null;
  depth: number;
  distribution_state: string;
  edit_summary: string | null;
  effective_community_ids: string[] | null;
  erasure_state: string;
  id: string;
  inbound_reference_count: number;
  kind: string;
  last_activity_at: Date;
  lifecycle_state: string;
  mentions: unknown;
  parent_id: string | null;
  primary_community_id: string | null;
  published_at: Date;
  public_node_serialized_bytes: number | null;
  references: unknown;
  reply_count: number;
  revision_created_at: Date | null;
  revision_created_by_actor_id: string | null;
  revision_id: string | null;
  revision_number: number | null;
  revision_title: string | null;
  root_id: string;
  source_links: unknown;
  source_version: number | null;
  symbols: string[] | null;
  topics: string[] | null;
  updated_at: Date;
  version: number;
}

type QuerySql = postgres.Sql | postgres.TransactionSql;

const contentSafety: ContentSafetyProjection = Object.freeze({
  executeEmbeddedCommands: false,
  instructionAuthority: "none",
  noAutomatedCopyTrading: true,
  noAutomatedTradeExecution: true,
  notInvestmentAdvice: true,
  socialSignalsAreNotVerification: true,
  untrustedUserGeneratedContent: true,
  verifyFinancialClaimsIndependently: true,
});

function zeroReactionCounts(): ReactionCountsProjection {
  return { agree: 0, disagree: 0, helpful: 0 };
}

function zeroReactionCountsByActorKind(): ReactionCountsByActorKindProjection {
  return { agent: zeroReactionCounts(), human: zeroReactionCounts() };
}

function emptyViewerState(): ViewerContentStateProjection {
  return { following: false, reactions: [] };
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function normalizeUuid(value: string, code: ContentReadErrorCode): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ContentReadError(code);
  }
  return normalized;
}

function normalizeUuidList(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length < 1 || values.length > 100) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const normalized = values.map((value) => normalizeUuid(value, "INVALID_ARGUMENT"));
  if (new Set(normalized).size !== normalized.length) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return uniqueSorted(normalized);
}

function normalizeSymbol(value: string): string {
  const normalized = value.normalize("NFC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/u.test(normalized)) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeSymbols(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length < 1 || values.length > 10) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const normalized = values.map(normalizeSymbol);
  if (new Set(normalized).size !== normalized.length) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return uniqueSorted(normalized);
}

function normalizeTopic(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeTopics(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length < 1 || values.length > 5) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const normalized = values.map(normalizeTopic);
  if (new Set(normalized).size !== normalized.length) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return uniqueSorted(normalized);
}

function normalizeContentTypes(
  values: readonly ContentKind[] | undefined,
): ContentKind[] {
  if (values === undefined) {
    return ["post"];
  }
  if (values.length < 1 || values.length > contentKinds.length) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const normalized = uniqueSorted(values);
  if (
    normalized.length !== values.length ||
    normalized.some((value) => !contentKinds.includes(value))
  ) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeDate(value: Date | string | undefined): Date | null {
  if (value === undefined) {
    return null;
  }
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return date;
}

function normalizeCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length < 1 || value.length > MAXIMUM_CURSOR_LENGTH || /\s/u.test(value)) {
    throw new ContentReadError("CURSOR_INVALID");
  }
  return value;
}

function normalizeInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? defaultValue;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return candidate;
}

export function normalizeContentBrowseInput(
  input: ContentBrowseInput,
  defaultLimit = DEFAULT_BROWSE_LIMIT,
): NormalizedContentBrowseInput {
  if (!browseScopes.includes(input.scope)) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const sort = input.sort ?? "latest";
  if (!browseSorts.includes(sort)) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const communityId =
    input.communityId === undefined
      ? null
      : normalizeUuid(input.communityId, "INVALID_ARGUMENT");
  const authorActorId =
    input.authorActorId === undefined
      ? null
      : normalizeUuid(input.authorActorId, "INVALID_ARGUMENT");
  const symbol = input.symbol === undefined ? null : normalizeSymbol(input.symbol);
  const topic = input.topic === undefined ? null : normalizeTopic(input.topic);
  const expectedTargets = {
    author: authorActorId,
    community: communityId,
    global: null,
    symbol,
    topic,
  } as const;
  const suppliedTargetCount = [communityId, authorActorId, symbol, topic].filter(
    (value) => value !== null,
  ).length;
  if (
    (input.scope === "global" && suppliedTargetCount !== 0) ||
    (input.scope !== "global" &&
      (expectedTargets[input.scope] === null || suppliedTargetCount !== 1))
  ) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  const createdAfter = normalizeDate(input.createdAfter);
  const createdBefore = normalizeDate(input.createdBefore);
  if (createdAfter !== null && createdBefore !== null && createdAfter >= createdBefore) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return {
    authorActorId,
    authorActorIds: normalizeUuidList(input.authorActorIds),
    communityId,
    contentTypes: normalizeContentTypes(input.contentTypes),
    createdAfter,
    createdBefore,
    cursor: normalizeCursor(input.cursor),
    limit: normalizeInteger(input.limit, defaultLimit, 1, MAXIMUM_BROWSE_LIMIT),
    scope: input.scope,
    sort,
    symbol,
    symbols: normalizeSymbols(input.symbols),
    topic,
    topics: normalizeTopics(input.topics),
  };
}

export function normalizeDiscussionInput(
  input: GetDiscussionInput,
  defaults: { byteBudget?: number; limit?: number } = {},
): NormalizedDiscussionInput {
  const sort = input.sort ?? "oldest";
  if (!discussionSorts.includes(sort)) {
    throw new ContentReadError("INVALID_ARGUMENT");
  }
  return {
    byteBudget: normalizeInteger(
      input.byteBudget,
      defaults.byteBudget ?? DEFAULT_DISCUSSION_BYTE_BUDGET,
      MINIMUM_DISCUSSION_BYTE_BUDGET,
      MAXIMUM_DISCUSSION_BYTE_BUDGET,
    ),
    contentId: normalizeUuid(input.contentId, "INVALID_ARGUMENT"),
    cursor: normalizeCursor(input.cursor),
    limit: normalizeInteger(
      input.limit,
      defaults.limit ?? DEFAULT_DISCUSSION_LIMIT,
      1,
      MAXIMUM_DISCUSSION_LIMIT,
    ),
    sort,
  };
}

function assertReadAllowed(
  viewer: ContentReadViewer,
  operation: "browse_content" | "get_content" | "get_discussion",
): void {
  if (viewer === null) {
    return;
  }
  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: viewer.credential.policyCeiling,
    operation,
    policyTier: viewer.agent.policy.tier,
    scopes: viewer.credential.scopes,
  });
  if (evaluation.decision !== "deny") {
    return;
  }
  throw new ContentReadError(
    evaluation.reason === "SCOPE_REQUIRED" ? "SCOPE_REQUIRED" : "POLICY_DENIED",
    { policyReason: evaluation.reason },
  );
}

function keyedDigest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function viewerCursorIdentity(viewer: ContentReadViewer): unknown {
  if (viewer === null) {
    return { principal: "anonymous-public" };
  }
  return {
    credential: {
      id: viewer.credential.id,
      policyCeiling: viewer.credential.policyCeiling,
      scopes: uniqueSorted(viewer.credential.scopes),
    },
    principal: {
      agentId: viewer.agent.id,
      ownerId: viewer.owner.id,
    },
    policy: {
      defaultsVersion: viewer.agent.policy.defaultsVersion,
      id: viewer.agent.policy.id,
      schemaVersion: viewer.agent.policy.schemaVersion,
      tier: viewer.agent.policy.tier,
      version: viewer.agent.policy.version,
    },
  };
}

function browseCursorBinding(
  key: Buffer,
  viewer: ContentReadViewer,
  input: NormalizedContentBrowseInput,
): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      kind: "browse",
      query: {
        authorActorId: input.authorActorId,
        authorActorIds: input.authorActorIds,
        communityId: input.communityId,
        contentTypes: input.contentTypes,
        createdAfter: input.createdAfter?.toISOString() ?? null,
        createdBefore: input.createdBefore?.toISOString() ?? null,
        limit: input.limit,
        scope: input.scope,
        sort: input.sort,
        symbol: input.symbol,
        symbols: input.symbols,
        topic: input.topic,
        topics: input.topics,
      },
      viewer: viewerCursorIdentity(viewer),
    }),
  );
}

function discussionCursorBinding(
  key: Buffer,
  viewer: ContentReadViewer,
  input: NormalizedDiscussionInput,
): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      kind: "discussion",
      query: {
        byteBudget: input.byteBudget,
        contentId: input.contentId,
        limit: input.limit,
        sort: input.sort,
      },
      viewer: viewerCursorIdentity(viewer),
    }),
  );
}

function makeSnapshotId(
  key: Buffer,
  kind: "browse" | "discussion",
  binding: string,
  asOf: Date,
  databaseSnapshot: string,
  visibilityEpoch: string,
): string {
  return `crs_${keyedDigest(
    key,
    SNAPSHOT_ID_DOMAIN,
    JSON.stringify({
      asOf: asOf.toISOString(),
      binding,
      databaseSnapshot,
      kind,
      visibilityEpoch,
    }),
  ).slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixedHexMatches(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function decodeCursorPayload(value: unknown): CursorPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    Object.keys(value).sort().join(",") !==
    "asOf,binding,databaseSnapshot,expiresAt,kind,last,snapshotId,v,visibilityEpoch"
  ) {
    return null;
  }
  const last = value.last;
  if (!isRecord(last) || Object.keys(last).sort().join(",") !== "at,id,position") {
    return null;
  }
  if (
    value.v !== CURSOR_VERSION ||
    (value.kind !== "browse" && value.kind !== "discussion") ||
    typeof value.asOf !== "string" ||
    typeof value.databaseSnapshot !== "string" ||
    !POSTGRES_SNAPSHOT_PATTERN.test(value.databaseSnapshot) ||
    typeof value.expiresAt !== "string" ||
    typeof value.binding !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.binding) ||
    typeof value.snapshotId !== "string" ||
    !/^crs_[0-9a-f]{32}$/u.test(value.snapshotId) ||
    typeof value.visibilityEpoch !== "string" ||
    !/^content:[1-9][0-9]{0,19}(?:;public:[1-9][0-9]{0,19})?$/u.test(
      value.visibilityEpoch,
    ) ||
    typeof last.at !== "string" ||
    typeof last.id !== "string" ||
    !UUID_PATTERN.test(last.id) ||
    typeof last.position !== "number" ||
    !Number.isInteger(last.position) ||
    last.position < 1
  ) {
    return null;
  }
  return {
    asOf: value.asOf,
    binding: value.binding,
    databaseSnapshot: value.databaseSnapshot,
    expiresAt: value.expiresAt,
    kind: value.kind,
    last: { at: last.at, id: last.id, position: last.position },
    snapshotId: value.snapshotId,
    visibilityEpoch: value.visibilityEpoch,
    v: value.v,
  };
}

function validateConstructorOptions(options: PostgresContentReadOptions): void {
  if (
    !Buffer.isBuffer(options.cursorSigningKey) ||
    options.cursorSigningKey.length < 32
  ) {
    throw new Error("The content cursor signing key must contain at least 32 bytes.");
  }
  const integerOptions: Array<[number | undefined, number, number, string]> = [
    [options.defaultBrowseLimit, 1, MAXIMUM_BROWSE_LIMIT, "browse limit"],
    [options.defaultDiscussionLimit, 1, MAXIMUM_DISCUSSION_LIMIT, "discussion limit"],
    [
      options.defaultDiscussionByteBudget,
      MINIMUM_DISCUSSION_BYTE_BUDGET,
      MAXIMUM_DISCUSSION_BYTE_BUDGET,
      "discussion byte budget",
    ],
    [options.cursorTtlSeconds, 60, 86_400, "cursor TTL"],
    [options.queryTimeoutMilliseconds, 100, 10_000, "query timeout"],
  ];
  for (const [value, minimum, maximum, label] of integerOptions) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < minimum || value > maximum)
    ) {
      throw new Error(`The content ${label} must be between ${minimum} and ${maximum}.`);
    }
  }
}

function asDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value;
}

function asOptionalDate(value: unknown): Date | null {
  return value === null ? null : asDate(value);
}

function asNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value;
}

function asPositiveInteger(value: unknown): number {
  const integer = asNonnegativeInteger(value);
  if (integer < 1) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return integer;
}

function asStringArray(value: unknown, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string") ||
    new Set(value).size !== value.length
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value as string[];
}

function mapAuthor(value: unknown): ContentAuthorProjection {
  if (!isRecord(value)) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "actorId,agentId,handle,kind" ||
    typeof value.actorId !== "string" ||
    !UUID_PATTERN.test(value.actorId) ||
    (value.kind !== "agent" && value.kind !== "human") ||
    typeof value.handle !== "string" ||
    (value.agentId !== null &&
      (typeof value.agentId !== "string" || !UUID_PATTERN.test(value.agentId))) ||
    (value.kind === "agent") !== (typeof value.agentId === "string")
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value.kind === "agent"
    ? {
        actorId: value.actorId,
        agentId: value.agentId as string,
        handle: value.handle,
        kind: "agent",
      }
    : { actorId: value.actorId, handle: value.handle, kind: "human" };
}

function mapSourceLinks(value: unknown): SourceLinkProjection[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sourceLinkId !== "string" ||
      typeof entry.url !== "string" ||
      (entry.title !== null && typeof entry.title !== "string") ||
      (entry.description !== null && typeof entry.description !== "string") ||
      typeof entry.addedRevisionId !== "string" ||
      typeof entry.addedByActorId !== "string" ||
      typeof entry.addedAt !== "string"
    ) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    const addedAt = new Date(entry.addedAt);
    if (!Number.isFinite(addedAt.valueOf())) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return {
      addedAt,
      addedByActorId: entry.addedByActorId,
      addedRevisionId: entry.addedRevisionId,
      description: entry.description,
      sourceLinkId: entry.sourceLinkId,
      title: entry.title,
      url: entry.url,
    };
  });
}

function mapReferences(value: unknown): ContentReferenceProjection[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.targetContentId !== "string" ||
      (entry.relationType !== "quote" && entry.relationType !== "reference")
    ) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return {
      relationType: entry.relationType,
      targetContentId: entry.targetContentId,
    };
  });
}

function mapRevision(row: ProjectionRow): RevisionProjection | null {
  if (row.lifecycle_state === "deleted") {
    return null;
  }
  if (
    row.revision_id === null ||
    row.revision_number === null ||
    row.source_version === null ||
    row.body_markdown === null ||
    row.body_plain_text === null ||
    row.revision_created_by_actor_id === null ||
    row.revision_created_at === null ||
    row.content_hash === null
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  if (
    (row.kind === "post" && row.revision_title === null) ||
    (row.kind === "reply" && row.revision_title !== null)
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  if (!Array.isArray(row.mentions) || row.mentions.length > 100) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  return {
    bodyMarkdown: row.body_markdown,
    bodyPlainText: row.body_plain_text,
    contentHash: `sha256:${row.content_hash}`,
    contentId: row.id,
    createdAt: asDate(row.revision_created_at),
    createdByActorId: row.revision_created_by_actor_id,
    editSummary: row.edit_summary,
    id: row.revision_id,
    mentions: row.mentions.map(mapAuthor),
    references: mapReferences(row.references),
    revisionNumber: asPositiveInteger(row.revision_number),
    sourceLinks: mapSourceLinks(row.source_links),
    sourceVersion: asPositiveInteger(row.source_version),
    title: row.revision_title,
  };
}

function mapProjectionRow(row: ProjectionRow): ContentDetailProjection {
  if (
    !contentKinds.includes(row.kind as ContentKind) ||
    (row.actor_kind !== "agent" && row.actor_kind !== "human") ||
    (row.lifecycle_state !== "published" && row.lifecycle_state !== "deleted") ||
    (row.distribution_state !== "normal" &&
      row.distribution_state !== "limited" &&
      row.distribution_state !== "hidden") ||
    (row.erasure_state !== "retained" && row.erasure_state !== "payload_erased")
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  const kind = row.kind as ContentKind;
  const lifecycleState = row.lifecycle_state;
  const effectiveCommunityIds = asStringArray(row.effective_community_ids ?? [], 5);
  asStringArray(row.additional_community_ids ?? [], 4);
  const projectedPrimaryCommunityId =
    kind === "post" ? (effectiveCommunityIds[0] ?? null) : null;
  const additionalCommunityIds = kind === "post" ? effectiveCommunityIds.slice(1) : [];
  const symbols =
    lifecycleState === "deleted" ? [] : asStringArray(row.symbols ?? [], 10);
  const topics = lifecycleState === "deleted" ? [] : asStringArray(row.topics ?? [], 5);
  const author: ContentAuthorProjection =
    row.actor_kind === "agent"
      ? (() => {
          if (row.agent_id === null) {
            throw new ContentReadError("CONTENT_DATA_INVALID");
          }
          return {
            actorId: row.actor_id,
            agentId: row.agent_id,
            handle: row.author_handle,
            kind: "agent",
          };
        })()
      : {
          actorId: row.actor_id,
          handle: row.author_handle,
          kind: "human",
        };
  const revision = mapRevision(row);
  const currentRevisionId =
    lifecycleState === "published" ? row.current_revision_id : null;
  if (
    (lifecycleState === "published" &&
      (revision === null || currentRevisionId === null)) ||
    row.distribution_state === "hidden" ||
    effectiveCommunityIds.length < 1 ||
    (kind === "post" && projectedPrimaryCommunityId === null) ||
    (kind === "reply" && row.primary_community_id !== null)
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  const version = asPositiveInteger(row.version);
  return {
    content: {
      additionalCommunityIds,
      author,
      createdAt: asDate(row.created_at),
      currentRevisionId,
      deletedAt: asOptionalDate(row.deleted_at),
      depth: asNonnegativeInteger(row.depth),
      distributionState: row.distribution_state,
      erasureState: row.erasure_state,
      id: row.id,
      kind,
      lastActivityAt: asDate(row.last_activity_at),
      lifecycleState,
      parentContentId: row.parent_id,
      primaryCommunityId: projectedPrimaryCommunityId,
      publishedAt: asDate(row.published_at),
      rootContentId: row.root_id,
      symbols,
      title: revision?.title ?? null,
      topics,
      updatedAt: asDate(row.updated_at),
      version,
    },
    contentSafety,
    countsAsOf: new Date(0),
    effectiveCommunityIds,
    inboundReferenceCount: asNonnegativeInteger(row.inbound_reference_count),
    reactionCounts: zeroReactionCounts(),
    reactionCountsByActorKind: zeroReactionCountsByActorKind(),
    replyCount: asNonnegativeInteger(row.reply_count),
    resourceVersion: version,
    revision,
    viewerState: emptyViewerState(),
  };
}

function toDiscussionNode(detail: ContentDetailProjection): DiscussionNodeProjection {
  const content = detail.content;
  return {
    author: content.author,
    contentSafety: detail.contentSafety,
    createdAt: content.createdAt,
    currentRevisionId: content.currentRevisionId,
    depth: content.depth,
    distributionState: content.distributionState,
    effectiveCommunityIds: detail.effectiveCommunityIds,
    id: content.id,
    inboundReferenceCount: detail.inboundReferenceCount,
    kind: content.kind,
    lastActivityAt: content.lastActivityAt,
    lifecycleState: content.lifecycleState,
    parentContentId: content.parentContentId,
    reactionCounts: detail.reactionCounts,
    reactionCountsByActorKind: detail.reactionCountsByActorKind,
    replyCount: detail.replyCount,
    revision: detail.revision,
    rootContentId: content.rootContentId,
    symbols: content.symbols,
    topics: content.topics,
    updatedAt: content.updatedAt,
    version: content.version,
    viewerState: detail.viewerState,
  };
}

function snippet(value: string, maximumCodePoints = 600): string {
  const points = [...value];
  return points.length <= maximumCodePoints
    ? value
    : `${points.slice(0, maximumCodePoints).join("")}…`;
}

function browseReasons(input: NormalizedContentBrowseInput): string[] {
  const reasons = [`scope:${input.scope}`, `sort:${input.sort}`];
  if (input.contentTypes.length !== 1 || input.contentTypes[0] !== "post") {
    reasons.push("filter:contentTypes");
  }
  if (input.authorActorIds.length > 0) reasons.push("filter:authors");
  if (input.symbols.length > 0) reasons.push("filter:symbols");
  if (input.topics.length > 0) reasons.push("filter:topics");
  if (input.createdAfter !== null || input.createdBefore !== null) {
    reasons.push("filter:createdAt");
  }
  return reasons;
}

function toBrowseItem(
  detail: ContentDetailProjection,
  rank: number,
  input: NormalizedContentBrowseInput,
  orderAt: Date,
): ContentBrowseItem {
  const content = detail.content;
  const revision = detail.revision;
  const effectivePrimaryCommunityId = detail.effectiveCommunityIds[0];
  if (
    revision === null ||
    content.currentRevisionId === null ||
    effectivePrimaryCommunityId === undefined
  ) {
    throw new ContentReadError("CONTENT_DATA_INVALID");
  }
  const score =
    input.sort === "active"
      ? orderAt.valueOf() / 1_000
      : content.publishedAt.valueOf() / 1_000;
  const lastActivityAt = input.sort === "active" ? orderAt : content.lastActivityAt;
  return {
    author: content.author,
    communityIds: detail.effectiveCommunityIds,
    contentId: content.id,
    contentSafety: detail.contentSafety,
    contentVersion: content.version,
    createdAt: content.createdAt,
    currentRevisionId: content.currentRevisionId,
    depth: content.depth,
    kind: content.kind,
    lastActivityAt,
    parentContentId: content.parentContentId,
    primaryCommunityId: effectivePrimaryCommunityId,
    rank,
    reactionCounts: detail.reactionCounts,
    reactionCountsByActorKind: detail.reactionCountsByActorKind,
    replyCount: detail.replyCount,
    rootContentId: content.rootContentId,
    score,
    selectionReasons: browseReasons(input),
    snippetMarkdown: snippet(revision.bodyMarkdown),
    snippetPlainText: snippet(revision.bodyPlainText),
    snippetSourceRevisionId: revision.id,
    symbols: content.symbols,
    title: content.title,
    topics: content.topics,
    updatedAt: content.updatedAt,
    viewerState: detail.viewerState,
  };
}

export class PostgresContentReadService implements ContentReadService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #cursorTtlMilliseconds: number;
  readonly #defaultBrowseLimit: number;
  readonly #defaultDiscussionByteBudget: number;
  readonly #defaultDiscussionLimit: number;
  readonly #queryTimeoutMilliseconds: number;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresContentReadOptions) {
    validateConstructorOptions(options);
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#cursorTtlMilliseconds =
      (options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS) * 1_000;
    this.#defaultBrowseLimit = options.defaultBrowseLimit ?? DEFAULT_BROWSE_LIMIT;
    this.#defaultDiscussionByteBudget =
      options.defaultDiscussionByteBudget ?? DEFAULT_DISCUSSION_BYTE_BUDGET;
    this.#defaultDiscussionLimit =
      options.defaultDiscussionLimit ?? DEFAULT_DISCUSSION_LIMIT;
    this.#queryTimeoutMilliseconds =
      options.queryTimeoutMilliseconds ?? DEFAULT_QUERY_TIMEOUT_MILLISECONDS;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await this.#setStatementTimeout(transaction, 1_500);
      return transaction<ReadyRow[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = ${COMMUNITY_RESEARCH_MIGRATION_VERSION}
              and name = ${COMMUNITY_RESEARCH_MIGRATION_NAME}
              and checksum = ${COMMUNITY_RESEARCH_MIGRATION_CHECKSUM}
          )
          and exists (
            select 1
            from system.schema_migrations
            where version = ${CONTENT_READ_VISIBILITY_MIGRATION_VERSION}
              and name = ${CONTENT_READ_VISIBILITY_MIGRATION_NAME}
              and checksum = ${CONTENT_READ_VISIBILITY_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.content_items') is not null
          and to_regclass('platform.content_revisions') is not null
          and to_regclass('platform.content_additional_communities') is not null
          and to_regclass('platform.content_symbols') is not null
          and to_regclass('platform.content_topics') is not null
          and to_regclass('platform.source_links') is not null
          and to_regclass('platform.content_relations') is not null
          and to_regclass('platform.mentions') is not null
          and to_regclass('platform.content_items_visible_latest_idx') is not null
          and to_regclass('platform.content_items_root_discussion_idx') is not null
          and to_regclass('system.content_read_visibility_epochs') is not null
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.content_items')
              and attname = 'content_read_created_xid'
              and atttypid = to_regtype('xid8')
              and attnotnull
              and not attisdropped
          )
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.content_revisions')
              and attname = 'content_read_created_xid'
              and atttypid = to_regtype('xid8')
              and attnotnull
              and not attisdropped
          )
          and (
            select count(*)
            from system.content_read_visibility_epochs
            where epoch_name in (
              'content_membership',
              'public_community_visibility'
            )
              and epoch > 0
          ) = 2
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.content_items')
              and tgname = 'content_items_advance_read_membership_epoch'
              and tgfoid = to_regprocedure(
                'platform.advance_content_membership_on_item_update()'
              )
              and tgtype = 17
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.content_items')
              and tgname = 'content_items_assign_read_created_xid'
              and tgfoid = to_regprocedure(
                'platform.assign_content_read_created_xid()'
              )
              and tgtype = 23
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.content_revisions')
              and tgname = 'content_revisions_assign_read_created_xid'
              and tgfoid = to_regprocedure(
                'platform.assign_content_read_created_xid()'
              )
              and tgtype = 7
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.communities')
              and tgname = 'communities_advance_public_read_visibility_epoch'
              and tgfoid = to_regprocedure(
                'platform.advance_public_visibility_on_community_update()'
              )
              and tgtype = 17
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and (
            select count(*)
            from pg_catalog.pg_trigger
            where (tgrelid, tgname) in (
              (
                to_regclass('platform.content_additional_communities'),
                'content_additional_communities_advance_read_membership_epoch'
              ),
              (
                to_regclass('platform.content_symbols'),
                'content_symbols_advance_read_membership_epoch'
              ),
              (
                to_regclass('platform.content_topics'),
                'content_topics_advance_read_membership_epoch'
              )
            )
              and tgfoid = to_regprocedure(
                'platform.advance_content_membership_on_mapping_change()'
              )
              and tgtype = 29
              and not tgisinternal
              and tgenabled in ('O', 'A')
          ) = 3
          and (
            select count(*)
            from pg_catalog.pg_trigger
            where (tgrelid, tgname) in (
              (
                to_regclass('platform.symbols'),
                'symbols_advance_read_membership_epoch'
              ),
              (
                to_regclass('platform.topics'),
                'topics_advance_read_membership_epoch'
              )
            )
              and tgfoid = to_regprocedure(
                'platform.advance_content_membership_on_catalog_key_update()'
              )
              and tgtype = 17
              and not tgisinternal
              and tgenabled in ('O', 'A')
          ) = 2
          and to_regprocedure('pg_catalog.pg_current_snapshot()') is not null
          and to_regprocedure('pg_catalog.pg_current_xact_id()') is not null
          and to_regprocedure('pg_catalog.pg_visible_in_snapshot(xid8,pg_snapshot)')
            is not null
          and to_regprocedure('public.digest(bytea,text)') is not null
          as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new ContentReadError("CONTENT_READ_NOT_READY");
    }
  }

  async browseContent(
    viewer: ContentReadViewer,
    input: ContentBrowseInput,
  ): Promise<ContentBrowsePage> {
    assertReadAllowed(viewer, "browse_content");
    const normalized = normalizeContentBrowseInput(input, this.#defaultBrowseLimit);
    const binding = browseCursorBinding(this.#cursorSigningKey, viewer, normalized);
    const cursor =
      normalized.cursor === null
        ? null
        : this.#parseCursor(normalized.cursor, "browse", binding);
    const result = await this.#sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const countsAsOf = await this.#databaseTime(transaction);
        const asOf = cursor?.asOf ?? countsAsOf;
        const visibilityEpoch = await this.#contentReadVisibilityEpoch(
          transaction,
          viewer === null,
        );
        if (cursor !== null && cursor.visibilityEpoch !== visibilityEpoch) {
          throw new ContentReadError("SNAPSHOT_EXPIRED");
        }
        if (normalized.scope === "community") {
          await this.#assertCommunityVisible(
            transaction,
            normalized.communityId!,
            viewer !== null,
          );
        }
        const databaseSnapshot =
          cursor?.databaseSnapshot ?? (await this.#databaseSnapshot(transaction));
        const candidates = await this.#selectBrowseCandidates(
          transaction,
          normalized,
          asOf,
          databaseSnapshot,
          cursor,
          viewer !== null,
        );
        const pageCandidates = candidates.slice(0, normalized.limit);
        const details = await this.#hydrateContent(
          transaction,
          pageCandidates.map((candidate) => candidate.id),
          viewer !== null,
        );
        return {
          asOf,
          candidates,
          countsAsOf,
          databaseSnapshot,
          details,
          pageCandidates,
          visibilityEpoch,
        };
      },
    );
    const hasMore = result.candidates.length > normalized.limit;
    const byId = new Map(result.details.map((detail) => [detail.content.id, detail]));
    const startingRank = cursor?.position ?? 0;
    const items = result.pageCandidates.map((candidate, index) => {
      const detail = byId.get(candidate.id);
      if (detail === undefined) {
        throw new ContentReadError("CONTENT_DATA_INVALID");
      }
      detail.countsAsOf = result.countsAsOf;
      return toBrowseItem(
        detail,
        startingRank + index + 1,
        normalized,
        candidate.order_at,
      );
    });
    const snapshotId =
      cursor?.snapshotId ??
      makeSnapshotId(
        this.#cursorSigningKey,
        "browse",
        binding,
        result.asOf,
        result.databaseSnapshot,
        result.visibilityEpoch,
      );
    const expiresAt =
      cursor?.expiresAt ?? new Date(result.asOf.valueOf() + this.#cursorTtlMilliseconds);
    const lastCandidate = result.pageCandidates.at(-1);
    return {
      countsAsOf: result.countsAsOf,
      items,
      page: {
        hasMore,
        limit: normalized.limit,
        nextCursor:
          hasMore && lastCandidate
            ? this.#createCursor({
                asOf: result.asOf,
                binding,
                databaseSnapshot: result.databaseSnapshot,
                expiresAt,
                kind: "browse",
                lastAt: lastCandidate.order_at,
                lastId: lastCandidate.id,
                position: startingRank + result.pageCandidates.length,
                snapshotId,
                visibilityEpoch: result.visibilityEpoch,
              })
            : null,
      },
      ranking: {
        asOf: result.asOf,
        expiresAt,
        rankingVersion: `${CONTENT_READ_ORDERING_VERSION}:${normalized.sort}`,
        snapshotId,
      },
    };
  }

  async getContent(
    viewer: ContentReadViewer,
    input: GetContentInput,
  ): Promise<ContentDetailProjection> {
    assertReadAllowed(viewer, "get_content");
    const contentId = normalizeUuid(input.contentId, "INVALID_ARGUMENT");
    const result = await this.#sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const countsAsOf = await this.#databaseTime(transaction);
        const details = await this.#hydrateContent(
          transaction,
          [contentId],
          viewer !== null,
        );
        return { countsAsOf, details };
      },
    );
    const detail = result.details[0];
    if (detail === undefined) {
      throw new ContentReadError("CONTENT_NOT_FOUND");
    }
    detail.countsAsOf = result.countsAsOf;
    return detail;
  }

  async getDiscussion(
    viewer: ContentReadViewer,
    input: GetDiscussionInput,
  ): Promise<DiscussionProjection> {
    assertReadAllowed(viewer, "get_discussion");
    const normalized = normalizeDiscussionInput(input, {
      byteBudget: this.#defaultDiscussionByteBudget,
      limit: this.#defaultDiscussionLimit,
    });
    const binding = discussionCursorBinding(this.#cursorSigningKey, viewer, normalized);
    const cursor =
      normalized.cursor === null
        ? null
        : this.#parseCursor(normalized.cursor, "discussion", binding);
    const result = await this.#sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const countsAsOf = await this.#databaseTime(transaction);
        const asOf = cursor?.asOf ?? countsAsOf;
        const visibilityEpoch = await this.#contentReadVisibilityEpoch(
          transaction,
          viewer === null,
        );
        if (cursor !== null && cursor.visibilityEpoch !== visibilityEpoch) {
          throw new ContentReadError("SNAPSHOT_EXPIRED");
        }
        const location = await this.#discussionLocation(
          transaction,
          normalized.contentId,
          viewer !== null,
        );
        const databaseSnapshot =
          cursor?.databaseSnapshot ?? (await this.#databaseSnapshot(transaction));
        const candidates = await this.#selectDiscussionCandidates(
          transaction,
          location.root_id,
          normalized,
          asOf,
          databaseSnapshot,
          cursor,
        );
        for (const candidate of candidates) {
          if (
            !Number.isInteger(candidate.serialized_bytes) ||
            candidate.serialized_bytes < 1 ||
            candidate.serialized_bytes > MINIMUM_DISCUSSION_BYTE_BUDGET
          ) {
            throw new ContentReadError("CONTENT_DATA_INVALID");
          }
        }
        const pageCandidates = candidates.slice(0, normalized.limit);
        const details = await this.#hydrateContent(
          transaction,
          [location.root_id, ...pageCandidates.map((candidate) => candidate.id)],
          viewer !== null,
        );
        const ancestors = await this.#discussionAncestors(
          transaction,
          normalized.contentId,
          location.root_id,
        );
        return {
          ancestors,
          asOf,
          candidates,
          countsAsOf,
          databaseSnapshot,
          details,
          location,
          pageCandidates,
          visibilityEpoch,
        };
      },
    );
    const byId = new Map(result.details.map((detail) => [detail.content.id, detail]));
    const rootDetail = byId.get(result.location.root_id);
    if (rootDetail === undefined || rootDetail.content.kind !== "post") {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    rootDetail.countsAsOf = result.countsAsOf;
    const candidateNodes = result.pageCandidates.map((candidate) => {
      const detail = byId.get(candidate.id);
      if (
        detail === undefined ||
        detail.content.kind !== "reply" ||
        detail.content.rootContentId !== rootDetail.content.id
      ) {
        throw new ContentReadError("CONTENT_DATA_INVALID");
      }
      detail.countsAsOf = result.countsAsOf;
      return toDiscussionNode(detail);
    });
    const snapshotId =
      cursor?.snapshotId ??
      makeSnapshotId(
        this.#cursorSigningKey,
        "discussion",
        binding,
        result.asOf,
        result.databaseSnapshot,
        result.visibilityEpoch,
      );
    const expiresAt =
      cursor?.expiresAt ?? new Date(result.asOf.valueOf() + this.#cursorTtlMilliseconds);
    const startingPosition = cursor?.position ?? 0;
    const ancestorContext = result.ancestors.map((ancestor) => ({
      depth: asNonnegativeInteger(ancestor.depth),
      id: ancestor.id,
      kind: ancestor.kind as ContentKind,
      parentContentId: ancestor.parent_id,
      rootContentId: ancestor.root_id,
    }));
    const root = toDiscussionNode(rootDetail);
    const selectedReplies: DiscussionNodeProjection[] = [];
    for (const [index, candidateNode] of candidateNodes.entries()) {
      const candidate = result.pageCandidates[index];
      if (candidate === undefined) {
        throw new ContentReadError("CONTENT_DATA_INVALID");
      }
      const tentativeReplies = [...selectedReplies, candidateNode];
      const tentativeHasMore = tentativeReplies.length < result.candidates.length;
      const tentativeCursor = tentativeHasMore
        ? this.#createCursor({
            asOf: result.asOf,
            binding,
            databaseSnapshot: result.databaseSnapshot,
            expiresAt,
            kind: "discussion",
            lastAt: candidate.order_at,
            lastId: candidate.id,
            position: startingPosition + tentativeReplies.length,
            snapshotId,
            visibilityEpoch: result.visibilityEpoch,
          })
        : null;
      const tentativeProjection = {
        ancestorContext,
        countsAsOf: result.countsAsOf,
        ordering: {
          asOf: result.asOf,
          expiresAt,
          orderingVersion: `${DISCUSSION_ORDERING_VERSION}:${normalized.sort}`,
          snapshotId,
        },
        page: {
          hasMore: tentativeHasMore,
          limit: normalized.limit,
          nextCursor: tentativeCursor,
          // false is one byte larger in JSON than true, making this a safe bound.
          truncatedByByteBudget: false,
        },
        replies: tentativeReplies,
        root,
      };
      const serializedBytes =
        Buffer.byteLength(JSON.stringify(tentativeProjection), "utf8") +
        DISCUSSION_API_ENVELOPE_RESERVE_BYTES;
      if (serializedBytes > normalized.byteBudget) {
        break;
      }
      selectedReplies.push(candidateNode);
    }
    if (selectedReplies.length === 0 && candidateNodes.length > 0) {
      // A response that cannot contain its root plus one otherwise-valid reply
      // cannot make lossless cursor progress without violating the hard budget.
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    const pageCapacity = Math.min(normalized.limit, result.candidates.length);
    const truncatedByByteBudget = selectedReplies.length < pageCapacity;
    const hasMore = selectedReplies.length < result.candidates.length;
    const lastIndex = selectedReplies.length - 1;
    const last = lastIndex >= 0 ? result.pageCandidates[lastIndex] : undefined;
    const projection: DiscussionProjection = {
      ancestorContext,
      countsAsOf: result.countsAsOf,
      ordering: {
        asOf: result.asOf,
        expiresAt,
        orderingVersion: `${DISCUSSION_ORDERING_VERSION}:${normalized.sort}`,
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
                databaseSnapshot: result.databaseSnapshot,
                expiresAt,
                kind: "discussion",
                lastAt: last.order_at,
                lastId: last.id,
                position: startingPosition + selectedReplies.length,
                snapshotId,
                visibilityEpoch: result.visibilityEpoch,
              })
            : null,
        truncatedByByteBudget,
      },
      replies: selectedReplies,
      root,
    };
    if (
      Buffer.byteLength(JSON.stringify(projection), "utf8") +
        DISCUSSION_API_ENVELOPE_RESERVE_BYTES >
      normalized.byteBudget
    ) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return projection;
  }

  async #setStatementTimeout(
    sql: QuerySql,
    maximum = this.#queryTimeoutMilliseconds,
  ): Promise<void> {
    await sql`
      select set_config(
        'statement_timeout',
        ${String(Math.min(maximum, this.#queryTimeoutMilliseconds))},
        true
      )
    `;
  }

  async #databaseTime(sql: QuerySql): Promise<Date> {
    const rows = await sql<DatabaseTimeRow[]>`
      select transaction_timestamp() as as_of
    `;
    if (rows.length !== 1) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return asDate(rows[0]?.as_of);
  }

  async #databaseSnapshot(sql: QuerySql): Promise<string> {
    const rows = await sql<DatabaseSnapshotRow[]>`
      select pg_current_snapshot()::text as database_snapshot
    `;
    const snapshot = rows[0]?.database_snapshot;
    if (
      rows.length !== 1 ||
      typeof snapshot !== "string" ||
      !POSTGRES_SNAPSHOT_PATTERN.test(snapshot) ||
      Buffer.byteLength(snapshot, "utf8") > 2_048
    ) {
      throw new ContentReadError("CONTENT_READ_NOT_READY");
    }
    return snapshot;
  }

  async #contentReadVisibilityEpoch(
    sql: QuerySql,
    anonymousViewer: boolean,
  ): Promise<string> {
    const rows = await sql<ContentReadVisibilityEpochRow[]>`
      select
        (
          select epoch::text
          from system.content_read_visibility_epochs
          where epoch_name = 'content_membership'
        ) as content_membership_epoch,
        case
          when ${anonymousViewer}::boolean then (
            select epoch::text
            from system.content_read_visibility_epochs
            where epoch_name = 'public_community_visibility'
          )
          else null
        end as public_community_visibility_epoch
    `;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      typeof row?.content_membership_epoch !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(row.content_membership_epoch) ||
      (anonymousViewer &&
        (typeof row.public_community_visibility_epoch !== "string" ||
          !/^[1-9][0-9]{0,19}$/u.test(row.public_community_visibility_epoch))) ||
      (!anonymousViewer && row.public_community_visibility_epoch !== null)
    ) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return anonymousViewer
      ? `content:${row.content_membership_epoch};public:${row.public_community_visibility_epoch}`
      : `content:${row.content_membership_epoch}`;
  }

  async #assertCommunityVisible(
    sql: QuerySql,
    communityId: string,
    allowSuspendedCommunity: boolean,
  ): Promise<void> {
    const rows = await sql<CommunityVisibilityRow[]>`
      select exists (
        select 1
        from platform.communities as community
        where community.id = ${communityId}::uuid
          and community.deleted_at is null
          and (
            ${allowSuspendedCommunity}::boolean
            or community.status <> 'suspended'
          )
      ) as visible
    `;
    if (rows.length !== 1 || typeof rows[0]?.visible !== "boolean") {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    if (!rows[0].visible) {
      throw new ContentReadError("COMMUNITY_NOT_FOUND");
    }
  }

  async #selectBrowseCandidates(
    sql: QuerySql,
    input: NormalizedContentBrowseInput,
    asOf: Date,
    databaseSnapshot: string,
    cursor: ParsedCursor | null,
    allowSuspendedCommunities: boolean,
  ): Promise<BrowseCandidateRow[]> {
    return sql<BrowseCandidateRow[]>`
      with candidates as (
        select
          content.id,
          case
            when ${input.sort}::text = 'active' and content.kind = 'post' then
              greatest(
                coalesce((
                  select max(content_revision.created_at)
                  from platform.content_revisions as content_revision
                  where content_revision.content_id = content.id
                    and content_revision.created_at <= ${asOf}
                    and pg_visible_in_snapshot(
                      content_revision.content_read_created_xid,
                      ${databaseSnapshot}::pg_snapshot
                    )
                ), content.published_at),
                coalesce((
                  select max(greatest(
                    reply.published_at,
                    coalesce((
                      select max(reply_revision.created_at)
                      from platform.content_revisions as reply_revision
                      where reply_revision.content_id = reply.id
                        and reply_revision.created_at <= ${asOf}
                        and pg_visible_in_snapshot(
                          reply_revision.content_read_created_xid,
                          ${databaseSnapshot}::pg_snapshot
                        )
                    ), reply.published_at)
                  ))
                  from platform.content_items as reply
                  where reply.root_id = content.id
                    and reply.id <> content.id
                    and reply.lifecycle_state = 'published'
                    and reply.distribution_state <> 'hidden'
                    and reply.published_at <= ${asOf}
                    and pg_visible_in_snapshot(
                      reply.content_read_created_xid,
                      ${databaseSnapshot}::pg_snapshot
                    )
                ), content.published_at)
              )
            when ${input.sort}::text = 'active' then
              greatest(
                content.published_at,
                coalesce((
                  select max(content_revision.created_at)
                  from platform.content_revisions as content_revision
                  where content_revision.content_id = content.id
                    and content_revision.created_at <= ${asOf}
                    and pg_visible_in_snapshot(
                      content_revision.content_read_created_xid,
                      ${databaseSnapshot}::pg_snapshot
                    )
                ), content.published_at)
              )
            else content.published_at
          end as order_at
        from platform.content_items as content
        where content.lifecycle_state = 'published'
          and content.distribution_state <> 'hidden'
          and content.published_at <= ${asOf}
          and content.created_at <= ${asOf}
          and pg_visible_in_snapshot(
            content.content_read_created_xid,
            ${databaseSnapshot}::pg_snapshot
          )
          and content.kind = any(${input.contentTypes}::text[])
          and exists (
            select 1
            from platform.content_items as visible_root
            where visible_root.id = content.root_id
              and visible_root.kind = 'post'
              and visible_root.lifecycle_state = 'published'
              and visible_root.distribution_state <> 'hidden'
              and exists (
                select 1
                from platform.communities as visible_community
                where visible_community.deleted_at is null
                  and (
                    ${allowSuspendedCommunities}::boolean
                    or visible_community.status <> 'suspended'
                  )
                  and (
                    visible_community.id = visible_root.primary_community_id
                    or exists (
                      select 1
                      from platform.content_additional_communities
                        as visible_additional
                      where visible_additional.content_id = visible_root.id
                        and visible_additional.community_id = visible_community.id
                    )
                  )
              )
          )
          and (
            ${input.createdAfter}::timestamptz is null
            or content.created_at > ${input.createdAfter}
          )
          and (
            ${input.createdBefore}::timestamptz is null
            or content.created_at < ${input.createdBefore}
          )
          and (
            cardinality(${input.authorActorIds}::uuid[]) = 0
            or content.author_actor_id = any(${input.authorActorIds}::uuid[])
          )
          and (
            cardinality(${input.symbols}::text[]) = 0
            or exists (
              select 1
              from platform.content_symbols as content_symbol
              join platform.symbols as symbol
                on symbol.id = content_symbol.symbol_id
              where content_symbol.content_id = content.id
                and symbol.ticker::text = any(${input.symbols}::text[])
            )
          )
          and (
            cardinality(${input.topics}::text[]) = 0
            or exists (
              select 1
              from platform.content_topics as content_topic
              join platform.topics as topic
                on topic.id = content_topic.topic_id
              where content_topic.content_id = content.id
                and topic.slug::text = any(${input.topics}::text[])
            )
          )
          and (
            ${input.scope}::text = 'global'
            or (
              ${input.scope}::text = 'author'
              and content.author_actor_id = ${input.authorActorId}::uuid
            )
            or (
              ${input.scope}::text = 'community'
              and exists (
                select 1
                from platform.communities as requested_community
                where requested_community.id = ${input.communityId}::uuid
                  and requested_community.deleted_at is null
                  and (
                    ${allowSuspendedCommunities}::boolean
                    or requested_community.status <> 'suspended'
                  )
              )
              and exists (
                select 1
                from platform.content_items as root
                left join platform.content_additional_communities as additional
                  on additional.content_id = root.id
                where root.id = content.root_id
                  and (
                    root.primary_community_id = ${input.communityId}::uuid
                    or additional.community_id = ${input.communityId}::uuid
                  )
              )
            )
            or (
              ${input.scope}::text = 'symbol'
              and exists (
                select 1
                from platform.content_symbols as content_symbol
                join platform.symbols as symbol
                  on symbol.id = content_symbol.symbol_id
                where content_symbol.content_id = content.id
                  and symbol.ticker::text = ${input.symbol}::text
              )
            )
            or (
              ${input.scope}::text = 'topic'
              and exists (
                select 1
                from platform.content_topics as content_topic
                join platform.topics as topic
                  on topic.id = content_topic.topic_id
                where content_topic.content_id = content.id
                  and topic.slug::text = ${input.topic}::text
              )
            )
          )
      )
      select id::text as id, order_at
      from candidates
      where (
        ${cursor?.lastAt ?? null}::timestamptz is null
        or (order_at, id) < (
          ${cursor?.lastAt ?? null}::timestamptz,
          ${cursor?.lastId ?? null}::uuid
        )
      )
      order by order_at desc, id desc
      limit ${input.limit + 1}
    `;
  }

  async #discussionLocation(
    sql: QuerySql,
    contentId: string,
    allowSuspendedCommunities: boolean,
  ): Promise<DiscussionLocationRow> {
    const rows = await sql<DiscussionLocationRow[]>`
      select
        requested.id::text as id,
        requested.kind,
        requested.root_id::text as root_id,
        requested.parent_id::text as parent_id,
        requested.depth::integer as depth
      from platform.content_items as requested
      join platform.content_items as root
        on root.id = requested.root_id
       and root.kind = 'post'
      where requested.id = ${contentId}::uuid
        and requested.distribution_state <> 'hidden'
        and root.distribution_state <> 'hidden'
        and exists (
          select 1
          from platform.communities as visible_community
          where visible_community.deleted_at is null
            and (
              ${allowSuspendedCommunities}::boolean
              or visible_community.status <> 'suspended'
            )
            and (
              visible_community.id = root.primary_community_id
              or exists (
                select 1
                from platform.content_additional_communities as visible_additional
                where visible_additional.content_id = root.id
                  and visible_additional.community_id = visible_community.id
              )
            )
        )
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new ContentReadError("CONTENT_NOT_FOUND");
    }
    if (
      rows.length !== 1 ||
      !contentKinds.includes(row.kind as ContentKind) ||
      !UUID_PATTERN.test(row.root_id)
    ) {
      throw new ContentReadError("CONTENT_DATA_INVALID");
    }
    return row;
  }

  async #discussionAncestors(
    sql: QuerySql,
    contentId: string,
    rootId: string,
  ): Promise<AncestorRow[]> {
    return sql<AncestorRow[]>`
      with recursive ancestor_chain as (
        select
          parent.id,
          parent.kind,
          parent.root_id,
          parent.parent_id,
          parent.depth
        from platform.content_items as requested
        join platform.content_items as parent
          on parent.id = requested.parent_id
        where requested.id = ${contentId}::uuid
          and parent.distribution_state <> 'hidden'

        union all

        select
          parent.id,
          parent.kind,
          parent.root_id,
          parent.parent_id,
          parent.depth
        from ancestor_chain as child
        join platform.content_items as parent
          on parent.id = child.parent_id
        where parent.distribution_state <> 'hidden'
      )
      select
        id::text as id,
        kind,
        root_id::text as root_id,
        parent_id::text as parent_id,
        depth::integer as depth
      from ancestor_chain
      where id <> ${rootId}::uuid
      order by depth asc, id asc
    `;
  }

  async #selectDiscussionCandidates(
    sql: QuerySql,
    rootId: string,
    input: NormalizedDiscussionInput,
    asOf: Date,
    databaseSnapshot: string,
    cursor: ParsedCursor | null,
  ): Promise<DiscussionCandidateRow[]> {
    return sql<DiscussionCandidateRow[]>`
      select
        reply.id::text as id,
        reply.published_at as order_at,
        case
          when reply.lifecycle_state = 'deleted' then ${TOMBSTONE_SERIALIZED_BYTES}
          else revision.public_node_serialized_bytes
        end::integer as serialized_bytes
      from platform.content_items as reply
      left join platform.content_revisions as revision
        on revision.id = reply.current_revision_id
       and revision.content_id = reply.id
      where reply.root_id = ${rootId}::uuid
        and reply.kind = 'reply'
        and reply.distribution_state <> 'hidden'
        and reply.published_at <= ${asOf}
        and pg_visible_in_snapshot(
          reply.content_read_created_xid,
          ${databaseSnapshot}::pg_snapshot
        )
        and (
          ${cursor?.lastAt ?? null}::timestamptz is null
          or (
            ${input.sort}::text = 'oldest'
            and (reply.published_at, reply.id) > (
              ${cursor?.lastAt ?? null}::timestamptz,
              ${cursor?.lastId ?? null}::uuid
            )
          )
          or (
            ${input.sort}::text = 'latest'
            and (reply.published_at, reply.id) < (
              ${cursor?.lastAt ?? null}::timestamptz,
              ${cursor?.lastId ?? null}::uuid
            )
          )
        )
      order by
        case when ${input.sort}::text = 'oldest' then reply.published_at end asc,
        case when ${input.sort}::text = 'oldest' then reply.id end asc,
        case when ${input.sort}::text = 'latest' then reply.published_at end desc,
        case when ${input.sort}::text = 'latest' then reply.id end desc
      limit ${input.limit + 1}
    `;
  }

  async #hydrateContent(
    sql: QuerySql,
    contentIds: readonly string[],
    allowSuspendedCommunities: boolean,
  ): Promise<ContentDetailProjection[]> {
    if (contentIds.length === 0) {
      return [];
    }
    const rows = await sql<ProjectionRow[]>`
      select
        content.id::text as id,
        content.version::integer as version,
        content.kind,
        content.author_actor_id::text as actor_id,
        actor.kind as actor_kind,
        actor.handle::text as author_handle,
        agent.id::text as agent_id,
        content.root_id::text as root_id,
        content.parent_id::text as parent_id,
        content.depth::integer as depth,
        content.lifecycle_state,
        content.distribution_state,
        content.erasure_state,
        content.primary_community_id::text as primary_community_id,
        content.published_at,
        content.created_at,
        content.updated_at,
        content.deleted_at,
        case
          when content.kind = 'post' then greatest(
            content.updated_at,
            coalesce((
              select max(reply.updated_at)
              from platform.content_items as reply
              where reply.root_id = content.id
                and reply.id <> content.id
                and reply.lifecycle_state = 'published'
                and reply.distribution_state <> 'hidden'
            ), content.updated_at)
          )
          else content.updated_at
        end as last_activity_at,
        case
          when content.lifecycle_state = 'published'
            then content.current_revision_id::text
          else null
        end as current_revision_id,
        case
          when content.lifecycle_state = 'published' then revision.id::text
          else null
        end as revision_id,
        case
          when content.lifecycle_state = 'published'
            then revision.revision_number::integer
          else null
        end as revision_number,
        case
          when content.lifecycle_state = 'published'
            then revision.source_version::integer
          else null
        end as source_version,
        case when content.lifecycle_state = 'published' then revision.title else null end
          as revision_title,
        case
          when content.lifecycle_state = 'published' then revision.body_markdown
          else null
        end as body_markdown,
        case
          when content.lifecycle_state = 'published' then revision.body_plain_text
          else null
        end as body_plain_text,
        case
          when content.lifecycle_state = 'published' then revision.edit_summary
          else null
        end as edit_summary,
        case
          when content.lifecycle_state = 'published'
            then revision.created_by_actor_id::text
          else null
        end as revision_created_by_actor_id,
        case
          when content.lifecycle_state = 'published' then revision.created_at
          else null
        end as revision_created_at,
        case
          when content.lifecycle_state = 'published'
            then encode(revision.content_hash, 'hex')
          else null
        end as content_hash,
        case
          when content.lifecycle_state = 'published'
            then revision.public_node_serialized_bytes
          else null
        end::integer as public_node_serialized_bytes,
        coalesce((
          select array_agg(additional.community_id::text order by additional.position)
          from platform.content_additional_communities as additional
          join platform.communities as additional_community
            on additional_community.id = additional.community_id
          where additional.content_id = content.id
            and additional_community.deleted_at is null
            and (
              ${allowSuspendedCommunities}::boolean
              or additional_community.status <> 'suspended'
            )
        ), array[]::text[]) as additional_community_ids,
        coalesce((
          select array_agg(effective.community_id order by effective.position)
          from (
            select primary_community.id::text as community_id, 0 as position
            from platform.communities as primary_community
            where primary_community.id = root.primary_community_id
              and primary_community.deleted_at is null
              and (
                ${allowSuspendedCommunities}::boolean
                or primary_community.status <> 'suspended'
              )

            union all

            select additional.community_id::text, additional.position::integer
            from platform.content_additional_communities as additional
            join platform.communities as additional_community
              on additional_community.id = additional.community_id
            where additional.content_id = root.id
              and additional_community.deleted_at is null
              and (
                ${allowSuspendedCommunities}::boolean
                or additional_community.status <> 'suspended'
              )
          ) as effective
        ), array[]::text[]) as effective_community_ids,
        coalesce((
          select array_agg(symbol.ticker::text order by content_symbol.position)
          from platform.content_symbols as content_symbol
          join platform.symbols as symbol
            on symbol.id = content_symbol.symbol_id
          where content_symbol.content_id = content.id
        ), array[]::text[]) as symbols,
        coalesce((
          select array_agg(topic.slug::text order by content_topic.position)
          from platform.content_topics as content_topic
          join platform.topics as topic
            on topic.id = content_topic.topic_id
          where content_topic.content_id = content.id
        ), array[]::text[]) as topics,
        case
          when content.lifecycle_state = 'published' then coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'sourceLinkId', source.id::text,
                'url', source.url,
                'title', source.title,
                'description', source.description,
                'addedRevisionId', source.added_revision_id::text,
                'addedByActorId', source.added_by_actor_id::text,
                'addedAt', source.added_at
              ) order by source.position, source.id
            )
            from platform.source_links as source
            where source.content_id = content.id
              and source.removed_revision_id is null
          ), '[]'::jsonb)
          else '[]'::jsonb
        end as source_links,
        case
          when content.lifecycle_state = 'published' then coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'actorId', mentioned.id::text,
                'kind', mentioned.kind,
                'handle', mentioned.handle::text,
                'agentId', mentioned_agent.id::text
              ) order by mention.position, mentioned.id
            )
            from platform.mentions as mention
            join platform.actors as mentioned
              on mentioned.id = mention.mentioned_actor_id
            left join platform.agents as mentioned_agent
              on mentioned_agent.actor_id = mentioned.id
            where mention.revision_id = revision.id
          ), '[]'::jsonb)
          else '[]'::jsonb
        end as mentions,
        case
          when content.lifecycle_state = 'published' then coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'targetContentId', relation.to_content_id::text,
                'relationType', relation.relation_type
              ) order by relation.position, relation.id
            )
            from platform.content_relations as relation
            where relation.from_content_id = content.id
              and relation.removed_revision_id is null
          ), '[]'::jsonb)
          else '[]'::jsonb
        end as references,
        (
          with recursive descendants as (
            select child.id, child.distribution_state
            from platform.content_items as child
            where child.parent_id = content.id

            union all

            select child.id, child.distribution_state
            from descendants as parent
            join platform.content_items as child
              on child.parent_id = parent.id
          )
          select count(*)::integer
          from descendants
          where distribution_state <> 'hidden'
        ) as reply_count,
        (
          select count(*)::integer
          from platform.content_relations as inbound
          join platform.content_items as source_content
            on source_content.id = inbound.from_content_id
          join platform.content_items as source_root
            on source_root.id = source_content.root_id
          where inbound.to_content_id = content.id
            and inbound.removed_revision_id is null
            and source_content.lifecycle_state = 'published'
            and source_content.distribution_state <> 'hidden'
            and source_root.distribution_state <> 'hidden'
            and exists (
              select 1
              from platform.communities as visible_source_community
              where visible_source_community.deleted_at is null
                and (
                  ${allowSuspendedCommunities}::boolean
                  or visible_source_community.status <> 'suspended'
                )
                and (
                  visible_source_community.id = source_root.primary_community_id
                  or exists (
                    select 1
                    from platform.content_additional_communities
                      as visible_source_additional
                    where visible_source_additional.content_id = source_root.id
                      and visible_source_additional.community_id =
                        visible_source_community.id
                  )
                )
            )
        ) as inbound_reference_count
      from platform.content_items as content
      join platform.actors as actor
        on actor.id = content.author_actor_id
      left join platform.agents as agent
        on agent.actor_id = actor.id
      join platform.content_items as root
        on root.id = content.root_id
       and root.kind = 'post'
      left join platform.content_revisions as revision
        on revision.id = content.current_revision_id
       and revision.content_id = content.id
      where content.id = any(${contentIds}::uuid[])
        and content.distribution_state <> 'hidden'
        and root.distribution_state <> 'hidden'
        and exists (
          select 1
          from platform.communities as visible_community
          where visible_community.deleted_at is null
            and (
              ${allowSuspendedCommunities}::boolean
              or visible_community.status <> 'suspended'
            )
            and (
              visible_community.id = root.primary_community_id
              or exists (
                select 1
                from platform.content_additional_communities as visible_additional
                where visible_additional.content_id = root.id
                  and visible_additional.community_id = visible_community.id
              )
            )
        )
    `;
    return rows.map(mapProjectionRow);
  }

  #createCursor(options: {
    asOf: Date;
    binding: string;
    databaseSnapshot: string;
    expiresAt: Date;
    kind: "browse" | "discussion";
    lastAt: Date;
    lastId: string;
    position: number;
    snapshotId: string;
    visibilityEpoch: string;
  }): string {
    const payload: CursorPayload = {
      asOf: options.asOf.toISOString(),
      binding: options.binding,
      databaseSnapshot: options.databaseSnapshot,
      expiresAt: options.expiresAt.toISOString(),
      kind: options.kind,
      last: {
        at: options.lastAt.toISOString(),
        id: options.lastId,
        position: options.position,
      },
      snapshotId: options.snapshotId,
      visibilityEpoch: options.visibilityEpoch,
      v: CURSOR_VERSION,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\u0000", "utf8")
      .update(encoded, "ascii")
      .digest("base64url");
    const cursor = `${encoded}.${signature}`;
    if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
      throw new ContentReadError("CONTENT_READ_NOT_READY");
    }
    return cursor;
  }

  #parseCursor(
    cursor: string,
    expectedKind: "browse" | "discussion",
    expectedBinding: string,
  ): ParsedCursor {
    const [encoded, suppliedSignature, extra] = cursor.split(".");
    if (
      !encoded ||
      !suppliedSignature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)
    ) {
      throw new ContentReadError("CURSOR_INVALID");
    }
    const expectedSignature = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\u0000", "utf8")
      .update(encoded, "ascii")
      .digest();
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    ) {
      throw new ContentReadError("CURSOR_INVALID");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new ContentReadError("CURSOR_INVALID");
    }
    const payload = decodeCursorPayload(decoded);
    if (
      payload === null ||
      payload.kind !== expectedKind ||
      !fixedHexMatches(payload.binding, expectedBinding)
    ) {
      throw new ContentReadError("CURSOR_INVALID");
    }
    const asOf = new Date(payload.asOf);
    const expiresAt = new Date(payload.expiresAt);
    const lastAt = new Date(payload.last.at);
    const now = this.#clock();
    if (
      !Number.isFinite(asOf.valueOf()) ||
      !Number.isFinite(expiresAt.valueOf()) ||
      !Number.isFinite(lastAt.valueOf()) ||
      expiresAt <= asOf ||
      lastAt > asOf ||
      asOf.valueOf() > now.valueOf() + MAXIMUM_CLOCK_SKEW_MILLISECONDS ||
      payload.snapshotId !==
        makeSnapshotId(
          this.#cursorSigningKey,
          expectedKind,
          expectedBinding,
          asOf,
          payload.databaseSnapshot,
          payload.visibilityEpoch,
        )
    ) {
      throw new ContentReadError("CURSOR_INVALID");
    }
    if (now >= expiresAt) {
      throw new ContentReadError("CURSOR_EXPIRED");
    }
    return {
      asOf,
      databaseSnapshot: payload.databaseSnapshot,
      expiresAt,
      lastAt,
      lastId: payload.last.id,
      position: payload.last.position,
      snapshotId: payload.snapshotId,
      visibilityEpoch: payload.visibilityEpoch,
    };
  }
}
