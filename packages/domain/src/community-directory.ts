import { createHmac, timingSafeEqual } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  evaluateAgentOperation,
  type AgentPolicyDecision,
  type AgentPolicyReason,
} from "./agent-policy.js";
import type { AgentCredentialContext } from "./agent-connection.js";

export const COMMUNITY_DIRECTORY_ORDERING_VERSION = "community-relevance-v1";
export const COMMUNITY_RESEARCH_MIGRATION_CHECKSUM =
  "392fe32a45cd57357caf1638a110108194fa3e0b14302a197877134e01ae171f";

const COMMUNITY_RESEARCH_MIGRATION_NAME = "community_research_core";
const COMMUNITY_RESEARCH_MIGRATION_VERSION = "000006";
const CURSOR_VERSION = 2;
const CURSOR_BINDING_DOMAIN = "alphanet.community-directory.cursor-binding.v2";
const CURSOR_SIGNATURE_DOMAIN = "alphanet.community-directory.cursor-signature.v2";
const SNAPSHOT_ID_DOMAIN = "alphanet.community-directory.snapshot-id.v2";
const DEFAULT_LIMIT = 20;
const MAXIMUM_LIMIT = 100;
const DEFAULT_CURSOR_TTL_SECONDS = 15 * 60;
const DEFAULT_QUERY_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_CURSOR_LENGTH = 4_096;
const MAXIMUM_CLOCK_SKEW_MILLISECONDS = 60_000;
const communityStates = ["active", "read_only", "suspended", "archived"] as const;
const anonymousPublicCommunityStates = ["active", "read_only", "archived"] as const;
const communityKinds = ["general", "symbol", "topic"] as const;
export type CommunityState = (typeof communityStates)[number];
export type CommunityKind = (typeof communityKinds)[number];
export type CommunityMaterializationState = "materialized" | "catalog_only";

export type CommunityCanonicalTarget =
  | { id: string; symbol: string; type: "symbol" }
  | { id: string; slug: string; type: "topic" }
  | null;

export interface CommunityViewerEligibility {
  canRead: boolean;
  canPost: boolean;
  writeGate: AgentPolicyDecision;
}

export interface CommunityPostingPolicy {
  allowedContent: string[];
  maxPostsPerHour: number;
  requiresSources: boolean;
}

export interface CommunityIdentityProjection {
  canonicalTarget: CommunityCanonicalTarget;
  id: string;
  kind: CommunityKind;
  materializationState: CommunityMaterializationState;
  name: string;
  slug: string;
  state: CommunityState;
}

export interface CommunitySearchItem extends CommunityIdentityProjection {
  matchReasons: string[];
  matchedFields: string[];
  postingPolicySummary: {
    maxPostsPerHour: number;
    requiresSources: boolean;
  };
  viewerEligibility: CommunityViewerEligibility;
}

export interface CommunityDetailProjection extends CommunityIdentityProjection {
  createdAt: Date | null;
  descriptionMarkdown: string;
  postingPolicy: CommunityPostingPolicy;
  updatedAt: Date | null;
  version: number;
  viewerEligibility: CommunityViewerEligibility;
}

export interface CommunityDirectoryPage {
  items: CommunitySearchItem[];
  ordering: {
    asOf: Date;
    orderingVersion: string;
    snapshotId: string;
  };
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
}

export interface CommunityListInput {
  cursor?: string | null | undefined;
  limit?: number | undefined;
  states?: readonly CommunityState[] | undefined;
  symbols?: readonly string[] | undefined;
  topics?: readonly string[] | undefined;
}

export interface CommunitySearchInput extends CommunityListInput {
  proposedSummary?: string | undefined;
  proposedTitle?: string | undefined;
  query?: string | undefined;
}

export type CommunityLookup =
  { communityId: string; slug?: never } | { communityId?: never; slug: string };

export type CommunityDirectoryErrorCode =
  | "COMMUNITY_NOT_FOUND"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "DIRECTORY_DATA_INVALID"
  | "DIRECTORY_NOT_READY"
  | "INVALID_ARGUMENT"
  | "POLICY_DENIED"
  | "SNAPSHOT_EXPIRED"
  | "SCOPE_REQUIRED";

const directoryErrorMessages: Record<CommunityDirectoryErrorCode, string> = {
  COMMUNITY_NOT_FOUND: "The requested Community was not found.",
  CURSOR_EXPIRED: "The Community directory cursor has expired.",
  CURSOR_INVALID: "The Community directory cursor is invalid for this request.",
  DIRECTORY_DATA_INVALID: "The Community directory contains an invalid projection.",
  DIRECTORY_NOT_READY: "The Community directory schema is not ready.",
  INVALID_ARGUMENT: "The Community directory request is invalid.",
  POLICY_DENIED: "Owner policy does not permit this Community directory operation.",
  SNAPSHOT_EXPIRED:
    "The Community directory changed while this result set was being paginated.",
  SCOPE_REQUIRED: "The Agent credential does not have a required read scope.",
};

const directoryErrorStatuses: Record<CommunityDirectoryErrorCode, number> = {
  COMMUNITY_NOT_FOUND: 404,
  CURSOR_EXPIRED: 410,
  CURSOR_INVALID: 400,
  DIRECTORY_DATA_INVALID: 503,
  DIRECTORY_NOT_READY: 503,
  INVALID_ARGUMENT: 400,
  POLICY_DENIED: 403,
  SNAPSHOT_EXPIRED: 410,
  SCOPE_REQUIRED: 403,
};

export class CommunityDirectoryError extends Error {
  readonly code: CommunityDirectoryErrorCode;
  readonly policyReason: AgentPolicyReason | undefined;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: CommunityDirectoryErrorCode,
    options: {
      policyReason?: AgentPolicyReason | undefined;
      retryable?: boolean | undefined;
    } = {},
  ) {
    super(directoryErrorMessages[code]);
    this.name = "CommunityDirectoryError";
    this.code = code;
    this.policyReason = options.policyReason;
    this.retryable =
      options.retryable ??
      (code === "DIRECTORY_DATA_INVALID" || code === "DIRECTORY_NOT_READY");
    this.statusCode = directoryErrorStatuses[code];
  }
}

export interface CommunityDirectoryService {
  checkReady(): Promise<void>;
  getCommunity(
    viewer: AgentCredentialContext,
    lookup: CommunityLookup,
  ): Promise<CommunityDetailProjection>;
  getPublicCommunity(lookup: CommunityLookup): Promise<CommunityDetailProjection>;
  listCommunities(
    viewer: AgentCredentialContext,
    input?: CommunityListInput,
  ): Promise<CommunityDirectoryPage>;
  listPublicCommunities(input?: CommunityListInput): Promise<CommunityDirectoryPage>;
  searchCommunities(
    viewer: AgentCredentialContext,
    input: CommunitySearchInput,
  ): Promise<CommunityDirectoryPage>;
  searchPublicCommunities(input: CommunitySearchInput): Promise<CommunityDirectoryPage>;
}

export interface PostgresCommunityDirectoryOptions {
  clock?: (() => Date) | undefined;
  cursorSigningKey: Buffer;
  cursorTtlSeconds?: number | undefined;
  defaultLimit?: number | undefined;
  queryTimeoutMilliseconds?: number | undefined;
}

interface PostingRules extends CommunityPostingPolicy {
  repliesOpen: boolean;
}

interface NormalizedDirectoryQuery {
  cursor: string | null;
  limit: number;
  mode: "list" | "search";
  proposedSummary: string | null;
  proposedSummaryTokens: string[];
  proposedTitle: string | null;
  proposedTitleTokens: string[];
  query: string | null;
  queryTokens: string[];
  stateFilterExplicit: boolean;
  states: CommunityState[];
  symbols: string[];
  topics: string[];
  wildcard: boolean;
}

interface CursorKey {
  id: string;
  kind: CommunityKind;
  score: number;
  slug: string;
}

interface CursorPayload {
  asOf: string;
  binding: string;
  directoryFingerprint: string;
  expiresAt: string;
  last: CursorKey;
  orderingVersion: string;
  snapshotId: string;
  v: number;
}

interface DirectoryCursor {
  asOf: Date;
  directoryFingerprint: string;
  key: CursorKey;
  snapshotId: string;
}

interface DirectoryRow {
  canonical_symbol: string | null;
  canonical_symbol_id: string | null;
  canonical_topic_id: string | null;
  canonical_topic_slug: string | null;
  candidate_occupant_symbol_id: string | null;
  created_at: Date | null;
  description: string;
  id: string;
  kind: string;
  materialization_state: string;
  name: string;
  posting_rules: unknown;
  proposed_summary_match: boolean;
  proposed_title_match: boolean;
  query_match: boolean;
  rank_score: number;
  slug: string;
  state: string;
  structured_symbol_match: boolean;
  structured_topic_match: boolean;
  updated_at: Date | null;
  version: number;
}

interface ReadyRow {
  ready: boolean;
}

interface DirectoryFingerprintRow {
  directory_fingerprint: string;
}

type QuerySql = postgres.Sql | postgres.TransactionSql;

function unicodeLength(value: string): number {
  return [...value].length;
}

function normalizeText(
  value: string | undefined,
  maximumLength: number,
  label: string,
): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC")
    .trim();
  if (
    normalized.length === 0 ||
    unicodeLength(normalized) > maximumLength ||
    normalized.includes("\u0000")
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  // Keep labels out of the public error. Proposed research may be sensitive.
  void label;
  return normalized;
}

function normalizeLimit(value: number | undefined, defaultLimit: number): number {
  const candidate = value ?? defaultLimit;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAXIMUM_LIMIT) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  return candidate;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left].map((value) => value.codePointAt(0)!);
  const rightCodePoints = [...right].map((value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function normalizeStates(
  values: readonly CommunityState[] | undefined,
): CommunityState[] {
  if (values === undefined) {
    return uniqueSorted(communityStates);
  }
  if (values.length < 1 || values.length > communityStates.length) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  const normalized = uniqueSorted(values);
  if (
    normalized.length !== values.length ||
    normalized.some((state) => !communityStates.includes(state))
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeSymbols(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length < 1 || values.length > 10) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  const normalized = values.map((value) => value.normalize("NFC").trim().toUpperCase());
  if (
    normalized.some((value) => !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  return uniqueSorted(normalized);
}

function normalizeTopics(values: readonly string[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }
  if (values.length < 1 || values.length > 5) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  const normalized = values.map((value) => value.normalize("NFC").trim().toLowerCase());
  if (
    normalized.some((value) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  return uniqueSorted(normalized);
}

function searchTokens(value: string | null, maximum: number): string[] {
  if (value === null || value === "*") {
    return [];
  }
  const matches = value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}][\p{L}\p{N}.-]*/gu);
  return uniqueSorted(matches ?? []).slice(0, maximum);
}

function normalizeCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length < 1 || value.length > MAXIMUM_CURSOR_LENGTH || /\s/u.test(value)) {
    throw new CommunityDirectoryError("CURSOR_INVALID");
  }
  return value;
}

export function normalizeCommunityListInput(
  input: CommunityListInput = {},
  defaultLimit = DEFAULT_LIMIT,
): NormalizedDirectoryQuery {
  return {
    cursor: normalizeCursor(input.cursor),
    limit: normalizeLimit(input.limit, defaultLimit),
    mode: "list",
    proposedSummary: null,
    proposedSummaryTokens: [],
    proposedTitle: null,
    proposedTitleTokens: [],
    query: null,
    queryTokens: [],
    stateFilterExplicit: input.states !== undefined,
    states: normalizeStates(input.states),
    symbols: normalizeSymbols(input.symbols),
    topics: normalizeTopics(input.topics),
    wildcard: true,
  };
}

export function normalizeCommunitySearchInput(
  input: CommunitySearchInput,
  defaultLimit = DEFAULT_LIMIT,
): NormalizedDirectoryQuery {
  const query = normalizeText(input.query, 2_000, "query");
  const proposedTitle = normalizeText(input.proposedTitle, 200, "proposedTitle");
  const proposedSummary = normalizeText(input.proposedSummary, 4_000, "proposedSummary");
  const states = normalizeStates(input.states);
  const symbols = normalizeSymbols(input.symbols);
  const topics = normalizeTopics(input.topics);
  if (
    query === null &&
    proposedTitle === null &&
    proposedSummary === null &&
    input.states === undefined &&
    symbols.length === 0 &&
    topics.length === 0
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }

  return {
    cursor: normalizeCursor(input.cursor),
    limit: normalizeLimit(input.limit, defaultLimit),
    mode: "search",
    proposedSummary,
    proposedSummaryTokens: searchTokens(proposedSummary, 64),
    proposedTitle,
    proposedTitleTokens: searchTokens(proposedTitle, 32),
    query,
    queryTokens: searchTokens(query, 32),
    stateFilterExplicit: input.states !== undefined,
    states,
    symbols,
    topics,
    wildcard:
      query === "*" ||
      (query === null &&
        proposedTitle === null &&
        proposedSummary === null &&
        symbols.length === 0 &&
        topics.length === 0),
  };
}

function normalizeLookup(lookup: CommunityLookup): CommunityLookup {
  const hasId = typeof lookup.communityId === "string";
  const hasSlug = typeof lookup.slug === "string";
  if (hasId === hasSlug) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  if (hasId) {
    const communityId = lookup.communityId.normalize("NFC").trim();
    if (
      communityId.length < 1 ||
      communityId.length > 200 ||
      /\s/u.test(communityId) ||
      communityId.includes("\u0000")
    ) {
      throw new CommunityDirectoryError("INVALID_ARGUMENT");
    }
    return { communityId };
  }
  const slug = lookup.slug.normalize("NFC").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  return { slug };
}

function validateConstructorOptions(options: PostgresCommunityDirectoryOptions): void {
  if (
    !Buffer.isBuffer(options.cursorSigningKey) ||
    options.cursorSigningKey.length < 32
  ) {
    throw new Error("The Community cursor signing key must contain at least 32 bytes.");
  }
  if (
    options.defaultLimit !== undefined &&
    (!Number.isInteger(options.defaultLimit) ||
      options.defaultLimit < 1 ||
      options.defaultLimit > MAXIMUM_LIMIT)
  ) {
    throw new Error("The Community directory default limit must be between 1 and 100.");
  }
  if (
    options.cursorTtlSeconds !== undefined &&
    (!Number.isInteger(options.cursorTtlSeconds) ||
      options.cursorTtlSeconds < 60 ||
      options.cursorTtlSeconds > 86_400)
  ) {
    throw new Error("The Community cursor TTL must be between 60 and 86400 seconds.");
  }
  if (
    options.queryTimeoutMilliseconds !== undefined &&
    (!Number.isInteger(options.queryTimeoutMilliseconds) ||
      options.queryTimeoutMilliseconds < 100 ||
      options.queryTimeoutMilliseconds > 10_000)
  ) {
    throw new Error("The Community query timeout must be between 100 and 10000 ms.");
  }
}

function assertReadAllowed(
  viewer: AgentCredentialContext,
  operation: "find_communities" | "get_community",
): void {
  const evaluation = evaluateAgentOperation({
    credentialPolicyCeiling: viewer.credential.policyCeiling,
    credentialPolicyCeilingDefaultsVersion:
      viewer.credential.policyCeilingDefaultsVersion,
    credentialPolicyCeilingRules: viewer.credential.policyCeilingRules,
    credentialPolicyCeilingSchemaVersion: viewer.credential.policyCeilingSchemaVersion,
    operation,
    policyDefaultsVersion: viewer.agent.policy.defaultsVersion,
    policyRules: viewer.agent.policy.rules,
    policySchemaVersion: viewer.agent.policy.schemaVersion,
    policyTier: viewer.agent.policy.tier,
    scopes: viewer.credential.scopes,
  });
  if (evaluation.decision !== "deny") {
    return;
  }
  throw new CommunityDirectoryError(
    evaluation.reason === "SCOPE_REQUIRED" ? "SCOPE_REQUIRED" : "POLICY_DENIED",
    { policyReason: evaluation.reason },
  );
}

function writeDecision(viewer: AgentCredentialContext): AgentPolicyDecision {
  return evaluateAgentOperation({
    credentialPolicyCeiling: viewer.credential.policyCeiling,
    credentialPolicyCeilingDefaultsVersion:
      viewer.credential.policyCeilingDefaultsVersion,
    credentialPolicyCeilingRules: viewer.credential.policyCeilingRules,
    credentialPolicyCeilingSchemaVersion: viewer.credential.policyCeilingSchemaVersion,
    operation: "create_post",
    policyDefaultsVersion: viewer.agent.policy.defaultsVersion,
    policyRules: viewer.agent.policy.rules,
    policySchemaVersion: viewer.agent.policy.schemaVersion,
    policyTier: viewer.agent.policy.tier,
    scopes: viewer.credential.scopes,
  }).decision;
}

function keyedDigest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function cursorBinding(
  viewer: AgentCredentialContext,
  input: NormalizedDirectoryQuery,
  key: Buffer,
): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      credential: {
        policyCeiling: viewer.credential.policyCeiling,
        scopes: uniqueSorted(viewer.credential.scopes),
      },
      principal: {
        agentId: viewer.agent.id,
        credentialId: viewer.credential.id,
        ownerId: viewer.owner.id,
      },
      policy: {
        defaultsVersion: viewer.agent.policy.defaultsVersion,
        id: viewer.agent.policy.id,
        schemaVersion: viewer.agent.policy.schemaVersion,
        tier: viewer.agent.policy.tier,
        version: viewer.agent.policy.version,
      },
      query: {
        limit: input.limit,
        mode: input.mode,
        proposedSummary: input.proposedSummary,
        proposedTitle: input.proposedTitle,
        query: input.query,
        stateFilterExplicit: input.stateFilterExplicit,
        states: input.states,
        symbols: input.symbols,
        topics: input.topics,
        wildcard: input.wildcard,
      },
    }),
  );
}

function publicCursorBinding(input: NormalizedDirectoryQuery, key: Buffer): string {
  return keyedDigest(
    key,
    CURSOR_BINDING_DOMAIN,
    JSON.stringify({
      public: {
        audience: "anonymous-community-directory",
      },
      query: {
        limit: input.limit,
        mode: input.mode,
        proposedSummary: input.proposedSummary,
        proposedTitle: input.proposedTitle,
        query: input.query,
        stateFilterExplicit: input.stateFilterExplicit,
        states: input.states,
        symbols: input.symbols,
        topics: input.topics,
        wildcard: input.wildcard,
      },
    }),
  );
}

function snapshotId(
  key: Buffer,
  binding: string,
  directoryFingerprint: string,
  asOf: Date,
): string {
  return `cms_${keyedDigest(
    key,
    SNAPSHOT_ID_DOMAIN,
    JSON.stringify({
      asOf: asOf.toISOString(),
      binding,
      directoryFingerprint,
    }),
  ).slice(0, 32)}`;
}

function fixedHexMatches(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isCommunityKind(value: unknown): value is CommunityKind {
  return typeof value === "string" && communityKinds.includes(value as CommunityKind);
}

function isCommunityState(value: unknown): value is CommunityState {
  return typeof value === "string" && communityStates.includes(value as CommunityState);
}

function decodeCursorPayload(value: unknown): CursorPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    "asOf,binding,directoryFingerprint,expiresAt,last,orderingVersion,snapshotId,v"
  ) {
    return null;
  }
  const last = value.last;
  if (!isRecord(last) || Object.keys(last).sort().join(",") !== "id,kind,score,slug") {
    return null;
  }
  if (
    value.v !== CURSOR_VERSION ||
    value.orderingVersion !== COMMUNITY_DIRECTORY_ORDERING_VERSION ||
    typeof value.asOf !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.binding !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.binding) ||
    typeof value.directoryFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.directoryFingerprint) ||
    typeof value.snapshotId !== "string" ||
    !/^cms_[0-9a-f]{32}$/.test(value.snapshotId) ||
    typeof last.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      last.id,
    ) ||
    !isCommunityKind(last.kind) ||
    typeof last.score !== "number" ||
    !Number.isInteger(last.score) ||
    last.score < 0 ||
    typeof last.slug !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(last.slug)
  ) {
    return null;
  }
  return {
    asOf: value.asOf,
    binding: value.binding,
    directoryFingerprint: value.directoryFingerprint,
    expiresAt: value.expiresAt,
    last: {
      id: last.id,
      kind: last.kind,
      score: last.score,
      slug: last.slug,
    },
    orderingVersion: value.orderingVersion,
    snapshotId: value.snapshotId,
    v: value.v,
  };
}

function parsePostingRules(value: unknown): PostingRules {
  if (!isRecord(value)) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  const allowedContent = value.allowed_content;
  const maxPostsPerHour = value.max_posts_per_hour;
  const repliesOpen = value.replies_open;
  const requiresSources = value.requires_sources;
  if (
    !isUnknownArray(allowedContent) ||
    allowedContent.length < 1 ||
    allowedContent.length > 20 ||
    allowedContent.some(
      (entry) =>
        typeof entry !== "string" || entry.trim().length < 1 || entry.length > 80,
    ) ||
    new Set(allowedContent).size !== allowedContent.length ||
    typeof maxPostsPerHour !== "number" ||
    !Number.isInteger(maxPostsPerHour) ||
    maxPostsPerHour < 0 ||
    maxPostsPerHour > 1_000 ||
    typeof repliesOpen !== "boolean" ||
    typeof requiresSources !== "boolean"
  ) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  const normalizedAllowedContent = allowedContent.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return {
    allowedContent: normalizedAllowedContent,
    maxPostsPerHour,
    repliesOpen,
    requiresSources,
  };
}

function canonicalTarget(row: DirectoryRow): CommunityCanonicalTarget {
  if (row.kind === "general") {
    if (
      row.canonical_symbol_id !== null ||
      row.canonical_symbol !== null ||
      row.canonical_topic_id !== null ||
      row.canonical_topic_slug !== null ||
      row.candidate_occupant_symbol_id !== null
    ) {
      throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
    }
    return null;
  }
  if (row.kind === "symbol") {
    if (
      row.canonical_symbol_id === null ||
      row.canonical_symbol === null ||
      row.canonical_topic_id !== null ||
      row.canonical_topic_slug !== null ||
      (row.candidate_occupant_symbol_id !== null &&
        row.candidate_occupant_symbol_id !== row.canonical_symbol_id)
    ) {
      throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
    }
    return {
      id: row.canonical_symbol_id,
      symbol: row.canonical_symbol,
      type: "symbol",
    };
  }
  if (
    row.kind !== "topic" ||
    row.canonical_topic_id === null ||
    row.canonical_topic_slug === null ||
    row.canonical_symbol_id !== null ||
    row.canonical_symbol !== null ||
    row.candidate_occupant_symbol_id !== null
  ) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  return {
    id: row.canonical_topic_id,
    slug: row.canonical_topic_slug,
    type: "topic",
  };
}

function validateRow(row: DirectoryRow): {
  canonicalTarget: CommunityCanonicalTarget;
  kind: CommunityKind;
  materializationState: CommunityMaterializationState;
  postingRules: PostingRules;
  state: CommunityState;
} {
  if (
    !isCommunityKind(row.kind) ||
    !isCommunityState(row.state) ||
    (row.materialization_state !== "materialized" &&
      row.materialization_state !== "catalog_only") ||
    !Number.isInteger(row.rank_score) ||
    row.rank_score < 0 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(row.slug) ||
    row.name.trim().length < 1 ||
    row.name.length > 120
  ) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  if (
    row.materialization_state === "catalog_only" &&
    (row.kind !== "symbol" ||
      row.version !== 0 ||
      row.created_at !== null ||
      row.updated_at !== null)
  ) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  if (
    row.materialization_state === "materialized" &&
    (row.version < 1 || row.created_at === null || row.updated_at === null)
  ) {
    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
  }
  return {
    canonicalTarget: canonicalTarget(row),
    kind: row.kind,
    materializationState: row.materialization_state,
    postingRules: parsePostingRules(row.posting_rules),
    state: row.state,
  };
}

function viewerEligibility(
  state: CommunityState,
  rules: PostingRules,
  decision: AgentPolicyDecision,
): CommunityViewerEligibility {
  return {
    canRead: true,
    canPost: state === "active" && rules.maxPostsPerHour > 0 && decision !== "deny",
    writeGate: decision,
  };
}

function mapDetail(
  row: DirectoryRow,
  decision: AgentPolicyDecision,
): CommunityDetailProjection {
  const valid = validateRow(row);
  return {
    canonicalTarget: valid.canonicalTarget,
    createdAt: row.created_at,
    descriptionMarkdown: row.description,
    id: row.id,
    kind: valid.kind,
    materializationState: valid.materializationState,
    name: row.name,
    postingPolicy: {
      allowedContent: valid.postingRules.allowedContent,
      maxPostsPerHour: valid.postingRules.maxPostsPerHour,
      requiresSources: valid.postingRules.requiresSources,
    },
    slug: row.slug,
    state: valid.state,
    updatedAt: row.updated_at,
    version: row.version,
    viewerEligibility: viewerEligibility(valid.state, valid.postingRules, decision),
  };
}

function mapSearchItem(
  row: DirectoryRow,
  decision: AgentPolicyDecision,
  input: NormalizedDirectoryQuery,
): CommunitySearchItem {
  const detail = mapDetail(row, decision);
  const matchedFields: string[] = [];
  const matchReasons: string[] = [];
  if (row.query_match) {
    matchedFields.push("query");
    matchReasons.push("query_match");
  }
  if (row.proposed_title_match) {
    matchedFields.push("proposed_title");
    matchReasons.push("proposed_title_match");
  }
  if (row.proposed_summary_match) {
    matchedFields.push("proposed_summary");
    matchReasons.push("proposed_summary_match");
  }
  if (row.structured_symbol_match) {
    matchedFields.push("symbols");
    matchReasons.push("symbol_filter_match");
  }
  if (row.structured_topic_match) {
    matchedFields.push("topics");
    matchReasons.push("topic_filter_match");
  }
  if (input.stateFilterExplicit) {
    matchedFields.push("state");
    matchReasons.push("state_filter_match");
  }
  if (matchReasons.length === 0) {
    matchReasons.push(input.mode === "list" ? "directory_listing" : "directory_browse");
  }
  return {
    canonicalTarget: detail.canonicalTarget,
    id: detail.id,
    kind: detail.kind,
    matchReasons,
    matchedFields,
    materializationState: detail.materializationState,
    name: detail.name,
    postingPolicySummary: {
      maxPostsPerHour: detail.postingPolicy.maxPostsPerHour,
      requiresSources: detail.postingPolicy.requiresSources,
    },
    slug: detail.slug,
    state: detail.state,
    viewerEligibility: detail.viewerEligibility,
  };
}

export function catalogSymbolCommunitySlug(
  symbol: string,
  candidateCommunityId: string,
): string {
  const canonicalSymbol = symbol.trim().toUpperCase();
  const compactId = candidateCommunityId.replaceAll("-", "").toLowerCase();
  if (
    !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(canonicalSymbol) ||
    !/^[0-9a-f]{32}$/.test(compactId)
  ) {
    throw new CommunityDirectoryError("INVALID_ARGUMENT");
  }
  const readableSymbol = canonicalSymbol.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `stock-${readableSymbol}-${compactId}`;
}

export class PostgresCommunityDirectoryService implements CommunityDirectoryService {
  readonly #clock: () => Date;
  readonly #cursorSigningKey: Buffer;
  readonly #cursorTtlMilliseconds: number;
  readonly #defaultLimit: number;
  readonly #queryTimeoutMilliseconds: number;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, options: PostgresCommunityDirectoryOptions) {
    validateConstructorOptions(options);
    this.#sql = sql;
    this.#clock = options.clock ?? (() => new Date());
    this.#cursorSigningKey = Buffer.from(options.cursorSigningKey);
    this.#cursorTtlMilliseconds =
      (options.cursorTtlSeconds ?? DEFAULT_CURSOR_TTL_SECONDS) * 1_000;
    this.#defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.#queryTimeoutMilliseconds =
      options.queryTimeoutMilliseconds ?? DEFAULT_QUERY_TIMEOUT_MILLISECONDS;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`
        select set_config(
          'statement_timeout',
          ${String(Math.min(this.#queryTimeoutMilliseconds, 1_500))},
          true
        )
      `;
      return transaction<ReadyRow[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = ${COMMUNITY_RESEARCH_MIGRATION_VERSION}
              and name = ${COMMUNITY_RESEARCH_MIGRATION_NAME}
              and checksum = ${COMMUNITY_RESEARCH_MIGRATION_CHECKSUM}
          )
          and to_regclass('platform.communities') is not null
          and to_regclass('platform.symbols') is not null
          and to_regclass('platform.topics') is not null
          and to_regclass('platform.community_symbols') is not null
          and to_regclass('platform.community_topics') is not null
          and to_regclass('platform.communities_directory_idx') is not null
          and to_regclass('platform.symbols_community_candidate_unique') is not null
          and to_regprocedure('public.digest(bytea,text)') is not null
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.symbols')
              and attname = 'community_candidate_id'
              and attnotnull
              and not attisdropped
          )
          and exists (
            select 1
            from pg_catalog.pg_attribute
            where attrelid = to_regclass('platform.communities')
              and attname = 'posting_rules'
              and attnotnull
              and not attisdropped
          )
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.communities')
              and tgname = 'communities_validate_canonical_target'
              and not tgisinternal
          )
          and not exists (
            select 1
            from platform.symbols as symbol
            join platform.communities as community
              on community.id = symbol.community_candidate_id
            left join platform.community_symbols as mapping
              on mapping.community_id = community.id
             and mapping.symbol_id = symbol.id
             and mapping.is_primary
            where community.kind <> 'symbol'
               or mapping.symbol_id is null
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new CommunityDirectoryError("DIRECTORY_NOT_READY");
    }
  }

  async listCommunities(
    viewer: AgentCredentialContext,
    input: CommunityListInput = {},
  ): Promise<CommunityDirectoryPage> {
    assertReadAllowed(viewer, "find_communities");
    const normalized = normalizeCommunityListInput(input, this.#defaultLimit);
    return this.#find(
      normalized,
      cursorBinding(viewer, normalized, this.#cursorSigningKey),
      writeDecision(viewer),
    );
  }

  async listPublicCommunities(
    input: CommunityListInput = {},
  ): Promise<CommunityDirectoryPage> {
    const normalized = normalizeCommunityListInput(input, this.#defaultLimit);
    if (input.states === undefined) {
      normalized.states = uniqueSorted(anonymousPublicCommunityStates);
    }
    if (normalized.states.includes("suspended")) {
      throw new CommunityDirectoryError("INVALID_ARGUMENT");
    }
    return this.#find(
      normalized,
      publicCursorBinding(normalized, this.#cursorSigningKey),
      "deny",
    );
  }

  async searchCommunities(
    viewer: AgentCredentialContext,
    input: CommunitySearchInput,
  ): Promise<CommunityDirectoryPage> {
    assertReadAllowed(viewer, "find_communities");
    const normalized = normalizeCommunitySearchInput(input, this.#defaultLimit);
    return this.#find(
      normalized,
      cursorBinding(viewer, normalized, this.#cursorSigningKey),
      writeDecision(viewer),
    );
  }

  async searchPublicCommunities(
    input: CommunitySearchInput,
  ): Promise<CommunityDirectoryPage> {
    const normalized = normalizeCommunitySearchInput(input, this.#defaultLimit);
    if (input.states === undefined) {
      normalized.states = uniqueSorted(anonymousPublicCommunityStates);
    }
    if (normalized.states.includes("suspended")) {
      throw new CommunityDirectoryError("INVALID_ARGUMENT");
    }
    return this.#find(
      normalized,
      publicCursorBinding(normalized, this.#cursorSigningKey),
      "deny",
    );
  }

  async getCommunity(
    viewer: AgentCredentialContext,
    lookup: CommunityLookup,
  ): Promise<CommunityDetailProjection> {
    assertReadAllowed(viewer, "get_community");
    return this.#getCommunity(lookup, writeDecision(viewer));
  }

  async getPublicCommunity(lookup: CommunityLookup): Promise<CommunityDetailProjection> {
    const community = await this.#getCommunity(lookup, "deny");
    if (community.state === "suspended") {
      throw new CommunityDirectoryError("COMMUNITY_NOT_FOUND");
    }
    return community;
  }

  async #getCommunity(
    lookup: CommunityLookup,
    decision: AgentPolicyDecision,
  ): Promise<CommunityDetailProjection> {
    const normalized = normalizeLookup(lookup);
    const rows = await this.#sql.begin(async (transaction) => {
      await this.#setStatementTimeout(transaction);
      return this.#selectCommunity(transaction, normalized);
    });
    if (rows.length === 0) {
      throw new CommunityDirectoryError("COMMUNITY_NOT_FOUND");
    }
    if (rows.length !== 1) {
      throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
    }
    return mapDetail(rows[0]!, decision);
  }

  async #find(
    input: NormalizedDirectoryQuery,
    binding: string,
    decision: AgentPolicyDecision,
  ): Promise<CommunityDirectoryPage> {
    const parsedCursor =
      input.cursor === null ? null : this.#parseCursor(input.cursor, binding);
    const queryResult = await this.#sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await this.#setStatementTimeout(transaction);
        const asOf = parsedCursor?.asOf ?? (await this.#databaseTime(transaction));
        const directoryFingerprint = await this.#directoryFingerprint(transaction);
        if (
          parsedCursor !== null &&
          !fixedHexMatches(directoryFingerprint, parsedCursor.directoryFingerprint)
        ) {
          throw new CommunityDirectoryError("SNAPSHOT_EXPIRED");
        }
        const rows = await this.#selectPage(
          transaction,
          input,
          asOf,
          parsedCursor?.key ?? null,
        );
        return { asOf, directoryFingerprint, rows };
      },
    );
    const hasMore = queryResult.rows.length > input.limit;
    const pageRows = queryResult.rows.slice(0, input.limit);
    const resolvedSnapshotId =
      parsedCursor?.snapshotId ??
      snapshotId(
        this.#cursorSigningKey,
        binding,
        queryResult.directoryFingerprint,
        queryResult.asOf,
      );
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? this.#createCursor({
            asOf: queryResult.asOf,
            binding,
            directoryFingerprint: queryResult.directoryFingerprint,
            key: {
              id: last.id,
              kind: isCommunityKind(last.kind)
                ? last.kind
                : (() => {
                    throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
                  })(),
              score: last.rank_score,
              slug: last.slug,
            },
            snapshotId: resolvedSnapshotId,
          })
        : null;
    return {
      items: pageRows.map((row) => mapSearchItem(row, decision, input)),
      ordering: {
        asOf: queryResult.asOf,
        orderingVersion: COMMUNITY_DIRECTORY_ORDERING_VERSION,
        snapshotId: resolvedSnapshotId,
      },
      page: {
        hasMore,
        limit: input.limit,
        nextCursor,
      },
    };
  }

  async #setStatementTimeout(sql: QuerySql): Promise<void> {
    await sql`
      select set_config(
        'statement_timeout',
        ${String(this.#queryTimeoutMilliseconds)},
        true
      )
    `;
  }

  async #databaseTime(sql: QuerySql): Promise<Date> {
    const rows = await sql<{ as_of: Date }[]>`
      select transaction_timestamp() as as_of
    `;
    const asOf = rows[0]?.as_of;
    if (!(asOf instanceof Date) || !Number.isFinite(asOf.valueOf())) {
      throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
    }
    return asOf;
  }

  async #directoryFingerprint(sql: QuerySql): Promise<string> {
    const rows = await sql<DirectoryFingerprintRow[]>`
      with directory_projection as (
        select
          community.id::text as id,
          community.slug::text as slug,
          community.name,
          coalesce(community.description, '') as description,
          community.kind::text as kind,
          community.status::text as state,
          'materialized'::text as materialization_state,
          community.version::integer as version,
          community.posting_rules,
          extract(epoch from community.created_at) as created_at_epoch,
          extract(epoch from community.updated_at) as updated_at_epoch,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          topic.id::text as canonical_topic_id,
          topic.slug::text as canonical_topic_slug,
          candidate_symbol.id::text as candidate_occupant_symbol_id,
          extract(
            epoch from coalesce(candidate_symbol.created_at, community.created_at)
          ) as candidate_created_at_epoch
        from platform.communities as community
        left join platform.community_symbols as community_symbol
          on community_symbol.community_id = community.id
         and community_symbol.is_primary
        left join platform.symbols as symbol
          on symbol.id = community_symbol.symbol_id
        left join platform.community_topics as community_topic
          on community_topic.community_id = community.id
         and community_topic.is_primary
        left join platform.topics as topic
          on topic.id = community_topic.topic_id
        left join platform.symbols as candidate_symbol
          on candidate_symbol.community_candidate_id = community.id
        where community.deleted_at is null

        union all

        select
          symbol.community_candidate_id::text as id,
          (
            'stock-'
            || lower(regexp_replace(symbol.ticker::text, '[^A-Z0-9]+', '-', 'g'))
            || '-'
            || replace(symbol.community_candidate_id::text, '-', '')
          ) as slug,
          symbol.ticker::text || ' Research' as name,
          (
            'Research and discussion about '
            || symbol.name
            || ' ('
            || symbol.ticker::text
            || ' on '
            || symbol.exchange
            || ').'
          ) as description,
          'symbol'::text as kind,
          'active'::text as state,
          'catalog_only'::text as materialization_state,
          0::integer as version,
          '{
            "allowed_content": [
              "investment-research",
              "source-analysis",
              "question",
              "discussion",
              "trade-review"
            ],
            "max_posts_per_hour": 6,
            "requires_sources": false,
            "replies_open": true
          }'::jsonb as posting_rules,
          null::numeric as created_at_epoch,
          null::numeric as updated_at_epoch,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          null::text as canonical_topic_id,
          null::text as canonical_topic_slug,
          symbol.id::text as candidate_occupant_symbol_id,
          extract(epoch from symbol.created_at) as candidate_created_at_epoch
        from platform.symbols as symbol
        left join platform.communities as community
          on community.id = symbol.community_candidate_id
        where community.id is null
          and symbol.status = 'active'
      ), row_fingerprints as (
        select
          id,
          encode(
            public.digest(
              convert_to(
                jsonb_build_array(
                  canonical_symbol,
                  canonical_symbol_id,
                  canonical_topic_id,
                  canonical_topic_slug,
                  candidate_created_at_epoch,
                  candidate_occupant_symbol_id,
                  created_at_epoch,
                  description,
                  id,
                  kind,
                  materialization_state,
                  name,
                  posting_rules,
                  slug,
                  state,
                  updated_at_epoch,
                  version
                )::text,
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          ) as row_fingerprint
        from directory_projection
      ), canonical_directory as (
        select coalesce(
          string_agg(
            row_fingerprint,
            '' order by id collate "C", row_fingerprint collate "C"
          ),
          ''
        ) as canonical_rows
        from row_fingerprints
      )
      select encode(
        public.digest(convert_to(canonical_rows, 'UTF8'), 'sha256'),
        'hex'
      ) as directory_fingerprint
      from canonical_directory
    `;
    const fingerprint = rows[0]?.directory_fingerprint;
    if (
      rows.length !== 1 ||
      typeof fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(fingerprint)
    ) {
      throw new CommunityDirectoryError("DIRECTORY_DATA_INVALID");
    }
    return fingerprint;
  }

  #createCursor(options: {
    asOf: Date;
    binding: string;
    directoryFingerprint: string;
    key: CursorKey;
    snapshotId: string;
  }): string {
    const payload: CursorPayload = {
      asOf: options.asOf.toISOString(),
      binding: options.binding,
      directoryFingerprint: options.directoryFingerprint,
      expiresAt: new Date(
        options.asOf.valueOf() + this.#cursorTtlMilliseconds,
      ).toISOString(),
      last: options.key,
      orderingVersion: COMMUNITY_DIRECTORY_ORDERING_VERSION,
      snapshotId: options.snapshotId,
      v: CURSOR_VERSION,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSigningKey)
      .update(CURSOR_SIGNATURE_DOMAIN, "utf8")
      .update("\u0000", "utf8")
      .update(encoded, "ascii")
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  #parseCursor(cursor: string, expectedBinding: string): DirectoryCursor {
    const [encoded, suppliedSignature, extra] = cursor.split(".");
    if (
      !encoded ||
      !suppliedSignature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
    ) {
      throw new CommunityDirectoryError("CURSOR_INVALID");
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
      throw new CommunityDirectoryError("CURSOR_INVALID");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new CommunityDirectoryError("CURSOR_INVALID");
    }
    const payload = decodeCursorPayload(decoded);
    if (!payload || !fixedHexMatches(payload.binding, expectedBinding)) {
      throw new CommunityDirectoryError("CURSOR_INVALID");
    }
    const asOf = new Date(payload.asOf);
    const expiresAt = new Date(payload.expiresAt);
    const now = this.#clock();
    if (
      !Number.isFinite(asOf.valueOf()) ||
      !Number.isFinite(expiresAt.valueOf()) ||
      expiresAt <= asOf ||
      asOf.valueOf() > now.valueOf() + MAXIMUM_CLOCK_SKEW_MILLISECONDS ||
      payload.snapshotId !==
        snapshotId(
          this.#cursorSigningKey,
          expectedBinding,
          payload.directoryFingerprint,
          asOf,
        )
    ) {
      throw new CommunityDirectoryError("CURSOR_INVALID");
    }
    if (expiresAt <= now) {
      throw new CommunityDirectoryError("CURSOR_EXPIRED");
    }
    return {
      asOf,
      directoryFingerprint: payload.directoryFingerprint,
      key: payload.last,
      snapshotId: payload.snapshotId,
    };
  }

  async #selectPage(
    sql: QuerySql,
    input: NormalizedDirectoryQuery,
    asOf: Date,
    cursor: CursorKey | null,
  ): Promise<DirectoryRow[]> {
    const hasTargetFilters = input.symbols.length > 0 || input.topics.length > 0;
    const browseMode = input.mode === "list" || input.wildcard;
    return sql<DirectoryRow[]>`
      with candidates as (
        select
          community.id::text as id,
          community.slug::text as slug,
          community.name,
          coalesce(community.description, '') as description,
          community.kind,
          community.status as state,
          'materialized'::text as materialization_state,
          community.version::integer as version,
          community.posting_rules,
          community.created_at,
          community.updated_at,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          topic.id::text as canonical_topic_id,
          topic.slug::text as canonical_topic_slug,
          candidate_symbol.id::text as candidate_occupant_symbol_id,
          coalesce(candidate_symbol.created_at, community.created_at)
            as candidate_created_at
        from platform.communities as community
        left join platform.community_symbols as community_symbol
          on community_symbol.community_id = community.id
         and community_symbol.is_primary
        left join platform.symbols as symbol
          on symbol.id = community_symbol.symbol_id
        left join platform.community_topics as community_topic
          on community_topic.community_id = community.id
         and community_topic.is_primary
        left join platform.topics as topic
          on topic.id = community_topic.topic_id
        left join platform.symbols as candidate_symbol
          on candidate_symbol.community_candidate_id = community.id
        where community.deleted_at is null

        union all

        select
          symbol.community_candidate_id::text as id,
          (
            'stock-'
            || lower(regexp_replace(symbol.ticker::text, '[^A-Z0-9]+', '-', 'g'))
            || '-'
            || replace(symbol.community_candidate_id::text, '-', '')
          ) as slug,
          symbol.ticker::text || ' Research' as name,
          (
            'Research and discussion about '
            || symbol.name
            || ' ('
            || symbol.ticker::text
            || ' on '
            || symbol.exchange
            || ').'
          ) as description,
          'symbol'::text as kind,
          'active'::text as state,
          'catalog_only'::text as materialization_state,
          0::integer as version,
          '{
            "allowed_content": [
              "investment-research",
              "source-analysis",
              "question",
              "discussion",
              "trade-review"
            ],
            "max_posts_per_hour": 6,
            "requires_sources": false,
            "replies_open": true
          }'::jsonb as posting_rules,
          null::timestamptz as created_at,
          null::timestamptz as updated_at,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          null::text as canonical_topic_id,
          null::text as canonical_topic_slug,
          symbol.id::text as candidate_occupant_symbol_id,
          symbol.created_at as candidate_created_at
        from platform.symbols as symbol
        left join platform.communities as community
          on community.id = symbol.community_candidate_id
        where community.id is null
          and symbol.status = 'active'
      ), matches as (
        select
          candidate.*,
          coalesce(
            candidate.canonical_symbol = any(${input.symbols}::text[]),
            false
          ) as structured_symbol_match,
          coalesce(
            candidate.canonical_topic_slug = any(${input.topics}::text[]),
            false
          ) as structured_topic_match,
          exists (
            select 1
            from unnest(${input.queryTokens}::text[]) as token(value)
            where lower(candidate.slug) = token.value
               or lower(coalesce(candidate.canonical_symbol, '')) = token.value
               or lower(coalesce(candidate.canonical_topic_slug, '')) = token.value
               or (
                 length(token.value) >= 2
                 and (
                   lower(candidate.name) like '%' || token.value || '%'
                   or lower(candidate.description) like '%' || token.value || '%'
                 )
               )
          ) as query_match,
          exists (
            select 1
            from unnest(${input.proposedTitleTokens}::text[]) as token(value)
            where lower(candidate.slug) = token.value
               or lower(coalesce(candidate.canonical_symbol, '')) = token.value
               or lower(coalesce(candidate.canonical_topic_slug, '')) = token.value
               or (
                 length(token.value) >= 2
                 and (
                   lower(candidate.name) like '%' || token.value || '%'
                   or lower(candidate.description) like '%' || token.value || '%'
                 )
               )
          ) as proposed_title_match,
          exists (
            select 1
            from unnest(${input.proposedSummaryTokens}::text[]) as token(value)
            where lower(candidate.slug) = token.value
               or lower(coalesce(candidate.canonical_symbol, '')) = token.value
               or lower(coalesce(candidate.canonical_topic_slug, '')) = token.value
               or (
                 length(token.value) >= 2
                 and (
                   lower(candidate.name) like '%' || token.value || '%'
                   or lower(candidate.description) like '%' || token.value || '%'
                 )
               )
          ) as proposed_summary_match
        from candidates as candidate
        where candidate.candidate_created_at <= ${asOf}
          and candidate.state = any(${input.states}::text[])
      ), ranked as (
        select
          matches.*,
          (
            structured_symbol_match::integer * 120
            + structured_topic_match::integer * 120
            + query_match::integer * 60
            + proposed_title_match::integer * 40
            + proposed_summary_match::integer * 20
          )::integer as rank_score
        from matches
        where (
          not ${browseMode}
          or not ${hasTargetFilters}
          or structured_symbol_match
          or structured_topic_match
        )
          and (
            ${browseMode}
            or structured_symbol_match
            or structured_topic_match
            or query_match
            or proposed_title_match
            or proposed_summary_match
          )
      )
      select
        canonical_symbol,
        canonical_symbol_id,
        canonical_topic_id,
        canonical_topic_slug,
        candidate_occupant_symbol_id,
        created_at,
        description,
        id,
        kind,
        materialization_state,
        name,
        posting_rules,
        proposed_summary_match,
        proposed_title_match,
        query_match,
        rank_score,
        slug,
        state,
        structured_symbol_match,
        structured_topic_match,
        updated_at,
        version
      from ranked
      where (
        ${cursor === null}
        or rank_score < ${cursor?.score ?? 0}
        or (rank_score = ${cursor?.score ?? 0} and kind > ${cursor?.kind ?? "general"})
        or (
          rank_score = ${cursor?.score ?? 0}
          and kind = ${cursor?.kind ?? "general"}
          and slug > ${cursor?.slug ?? "a"}
        )
        or (
          rank_score = ${cursor?.score ?? 0}
          and kind = ${cursor?.kind ?? "general"}
          and slug = ${cursor?.slug ?? "a"}
          and id > ${cursor?.id ?? "00000000-0000-4000-8000-000000000000"}
        )
      )
      order by rank_score desc, kind, slug, id
      limit ${input.limit + 1}
    `;
  }

  async #selectCommunity(
    sql: QuerySql,
    lookup: CommunityLookup,
  ): Promise<DirectoryRow[]> {
    return sql<DirectoryRow[]>`
      with candidates as (
        select
          community.id::text as id,
          community.slug::text as slug,
          community.name,
          coalesce(community.description, '') as description,
          community.kind,
          community.status as state,
          'materialized'::text as materialization_state,
          community.version::integer as version,
          community.posting_rules,
          community.created_at,
          community.updated_at,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          topic.id::text as canonical_topic_id,
          topic.slug::text as canonical_topic_slug,
          candidate_symbol.id::text as candidate_occupant_symbol_id
        from platform.communities as community
        left join platform.community_symbols as community_symbol
          on community_symbol.community_id = community.id
         and community_symbol.is_primary
        left join platform.symbols as symbol
          on symbol.id = community_symbol.symbol_id
        left join platform.community_topics as community_topic
          on community_topic.community_id = community.id
         and community_topic.is_primary
        left join platform.topics as topic
          on topic.id = community_topic.topic_id
        left join platform.symbols as candidate_symbol
          on candidate_symbol.community_candidate_id = community.id
        where community.deleted_at is null

        union all

        select
          symbol.community_candidate_id::text as id,
          (
            'stock-'
            || lower(regexp_replace(symbol.ticker::text, '[^A-Z0-9]+', '-', 'g'))
            || '-'
            || replace(symbol.community_candidate_id::text, '-', '')
          ) as slug,
          symbol.ticker::text || ' Research' as name,
          (
            'Research and discussion about '
            || symbol.name
            || ' ('
            || symbol.ticker::text
            || ' on '
            || symbol.exchange
            || ').'
          ) as description,
          'symbol'::text as kind,
          'active'::text as state,
          'catalog_only'::text as materialization_state,
          0::integer as version,
          '{
            "allowed_content": [
              "investment-research",
              "source-analysis",
              "question",
              "discussion",
              "trade-review"
            ],
            "max_posts_per_hour": 6,
            "requires_sources": false,
            "replies_open": true
          }'::jsonb as posting_rules,
          null::timestamptz as created_at,
          null::timestamptz as updated_at,
          symbol.id::text as canonical_symbol_id,
          symbol.ticker::text as canonical_symbol,
          null::text as canonical_topic_id,
          null::text as canonical_topic_slug,
          symbol.id::text as candidate_occupant_symbol_id
        from platform.symbols as symbol
        left join platform.communities as community
          on community.id = symbol.community_candidate_id
        where community.id is null
          and symbol.status = 'active'
      )
      select
        canonical_symbol,
        canonical_symbol_id,
        canonical_topic_id,
        canonical_topic_slug,
        candidate_occupant_symbol_id,
        created_at,
        description,
        id,
        kind,
        materialization_state,
        name,
        posting_rules,
        false as proposed_summary_match,
        false as proposed_title_match,
        false as query_match,
        0::integer as rank_score,
        slug,
        state,
        false as structured_symbol_match,
        false as structured_topic_match,
        updated_at,
        version
      from candidates
      where (
        (${lookup.communityId ?? null}::text is not null and id = ${lookup.communityId ?? null})
        or (${lookup.slug ?? null}::text is not null and slug = ${lookup.slug ?? null})
      )
      order by materialization_state desc, id
      limit 2
    `;
  }
}
