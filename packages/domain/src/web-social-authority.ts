import type { PostgresClient } from "@alphanet/database";
import type postgres from "postgres";

import {
  type AgentPolicyTier,
  type AgentPolicyView,
  type OwnerAgentView,
} from "./agent-connection.js";
import {
  AGENT_OPERATIONS,
  AGENT_POLICY_DEFAULTS_VERSION,
  AGENT_POLICY_RULE_KEYS,
  AGENT_POLICY_SCHEMA_VERSION,
  materializeAgentPolicyRules,
  parseAgentPolicyRules,
  parsePersistedAgentPolicyRules,
  type AgentOperation,
  type AgentPolicyDecision,
  type AgentPolicyRuleKey,
  type AgentPolicyRules,
} from "./agent-policy.js";
import {
  OwnerWebSessionContextError,
  type OwnerWebAuthenticationAssurance,
  type OwnerWebContextVerifier,
  type OwnerWebMutationContext,
} from "./owner-web-session-context.js";
import { OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM } from "./schema-migrations.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POLICY_TIERS = new Set<string>(["read_only", "assisted", "autonomous", "custom"]);
const OPERATION_SET = new Set<string>(AGENT_OPERATIONS);
const POLICY_RULE_KEY_SET = new Set<string>(AGENT_POLICY_RULE_KEYS);
const OWNER_DIRECT_INPUT_KEYS = ["agentId", "kind"] as const;
const HUMAN_DIRECT_INPUT_KEYS = ["actorId", "kind"] as const;
const AUTHORITY_REQUEST_CONTEXT_KEYS = [
  "authenticatedAt",
  "authenticationAssurance",
  "channel",
  "csrfValidated",
  "ownerId",
  "requestId",
] as const;

const LEGACY_ASSISTED_RULES = {
  browse: "allow",
  content_read: "allow",
  notification_read: "allow",
  search: "allow",
  reaction_write: "allow",
  follow_write: "allow",
  content_write: "require_approval",
  reply_write: "require_approval",
  edit_own_content: "require_approval",
  delete_own_content: "require_approval",
} as const satisfies Record<AgentPolicyRuleKey, AgentPolicyDecision>;

export type WebSocialAuthoritySelection =
  | Readonly<{
      agentId: string;
      kind: "owner_direct";
    }>
  | Readonly<{
      actorId: string;
      kind: "human_direct";
    }>;

export interface WebSocialAuthorityRequestContext {
  readonly ownerId: string;
  readonly requestId: string;
  readonly authenticatedAt: Date;
  readonly authenticationAssurance: OwnerWebAuthenticationAssurance;
  readonly csrfValidated: true;
  readonly channel: "web";
}

export interface WebSocialActorView {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "agent" | "human";
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly status: "active";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type WebSocialAgentPolicyView = Readonly<
  Omit<AgentPolicyView, "effectiveFrom" | "rules"> & {
    readonly effectiveFrom: Date;
    readonly rules: Readonly<{
      readonly operations: Readonly<
        Partial<Record<AgentPolicyRuleKey, AgentPolicyDecision>>
      >;
    }>;
  }
>;

export type WebSocialOwnerAgentView = Readonly<
  Omit<
    OwnerAgentView,
    "activatedAt" | "archivedAt" | "createdAt" | "discoveryTags" | "policy" | "updatedAt"
  > & {
    readonly activatedAt: Date;
    readonly archivedAt: null;
    readonly createdAt: Date;
    readonly discoveryTags: readonly string[];
    readonly policy: WebSocialAgentPolicyView;
    readonly updatedAt: Date;
  }
>;

const WEB_SOCIAL_AUTHORITY_BRAND: unique symbol = Symbol(
  "AlphaNetWebSocialWriteAuthority",
);
const ISSUED_WEB_SOCIAL_AUTHORITIES = new WeakSet<object>();

export interface OwnerDirectAgentAuthority {
  readonly [WEB_SOCIAL_AUTHORITY_BRAND]: true;
  readonly kind: "owner_direct";
  readonly owner: Readonly<{ id: string }>;
  readonly actor: Readonly<WebSocialActorView & { kind: "agent" }>;
  readonly agent: WebSocialOwnerAgentView;
  readonly currentPolicy: WebSocialAgentPolicyView;
  readonly credential: null;
  readonly channel: "web";
  readonly approvalMethod: "owner_direct";
  readonly principalScopeKey: `owner_direct:${string}:${string}`;
  readonly requestContext: WebSocialAuthorityRequestContext;
  readonly authorityCheckedAt: Date;
}

export interface HumanDirectAuthority {
  readonly [WEB_SOCIAL_AUTHORITY_BRAND]: true;
  readonly kind: "human_direct";
  readonly owner: Readonly<{ id: string }>;
  readonly actor: Readonly<WebSocialActorView & { kind: "human" }>;
  readonly agent: null;
  readonly currentPolicy: null;
  readonly credential: null;
  readonly channel: "web";
  readonly approvalMethod: "human_direct";
  readonly principalScopeKey: `human_web:${string}:${string}`;
  readonly requestContext: WebSocialAuthorityRequestContext;
  readonly authorityCheckedAt: Date;
}

export type WebSocialAuthority = OwnerDirectAgentAuthority | HumanDirectAuthority;

export type WebSocialAuthorityErrorCode =
  | "AUTHORITY_NOT_FOUND"
  | "INVALID_AUTHORITY_SELECTION"
  | "OWNER_NOT_ELIGIBLE"
  | "SCHEMA_NOT_READY";

const ERROR_DEFINITIONS = {
  AUTHORITY_NOT_FOUND: {
    message: "The selected Web social authority is unavailable.",
    retryable: false,
    statusCode: 404,
  },
  INVALID_AUTHORITY_SELECTION: {
    message: "The selected Web social authority is invalid.",
    retryable: false,
    statusCode: 400,
  },
  OWNER_NOT_ELIGIBLE: {
    message: "The Owner cannot use Web social actions.",
    retryable: false,
    statusCode: 403,
  },
  SCHEMA_NOT_READY: {
    message: "The Web social authority schema is unavailable.",
    retryable: true,
    statusCode: 503,
  },
} as const satisfies Record<
  WebSocialAuthorityErrorCode,
  { message: string; retryable: boolean; statusCode: number }
>;

export class WebSocialAuthorityError extends Error {
  readonly code: WebSocialAuthorityErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: WebSocialAuthorityErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "WebSocialAuthorityError";
    this.code = code;
    this.retryable = definition.retryable;
    this.statusCode = definition.statusCode;
  }
}

export type OwnerDirectOperationReason =
  | "ALLOWED_BY_POLICY"
  | "OWNER_DIRECT_APPROVAL_SATISFIED"
  | "POLICY_DENIED"
  | "POLICY_RULES_UNAVAILABLE";

export interface OwnerDirectOperationEvaluation {
  readonly approvalSatisfied: boolean;
  readonly decision: "allow" | "deny";
  readonly ownerPolicyDecision: AgentPolicyDecision;
  readonly reason: OwnerDirectOperationReason;
}

export interface WebSocialAuthorityResolver {
  checkReady(): Promise<void>;
  resolveAuthorityInTransaction(
    transaction: postgres.TransactionSql,
    context: OwnerWebMutationContext,
    selection: WebSocialAuthoritySelection,
  ): Promise<WebSocialAuthority>;
}

interface NormalizedOwnerDirectSelection {
  agentId: string;
  kind: "owner_direct";
}

interface NormalizedHumanDirectSelection {
  actorId: string;
  kind: "human_direct";
}

type NormalizedSelection =
  NormalizedOwnerDirectSelection | NormalizedHumanDirectSelection;

interface OwnerAuthorityRow {
  id: string;
  status: string;
  email_verified_at: Date | null;
  deleted_at: Date | null;
}

interface AuthorityTimeRow {
  authority_checked_at: Date;
}

interface HumanAuthorityRow {
  actor_id: string;
  actor_owner_id: string;
  actor_kind: string;
  actor_handle: string;
  actor_display_name: string;
  actor_bio: string | null;
  actor_status: string;
  actor_created_at: Date;
  actor_updated_at: Date;
  actor_deleted_at: Date | null;
}

interface AgentAuthorityRow extends HumanAuthorityRow {
  agent_id: string;
  agent_actor_id: string;
  agent_owner_id: string;
  agent_discovery_tags: unknown;
  agent_status: string;
  agent_restriction_reason_code: string | null;
  agent_credential_count: number;
  agent_created_at: Date;
  agent_updated_at: Date;
  agent_activated_at: Date | null;
  agent_archived_at: Date | null;
  agent_deleted_at: Date | null;
  policy_id: string;
  policy_agent_id: string;
  policy_tier: string;
  policy_defaults_version: string;
  policy_schema_version: number;
  policy_version: string;
  policy_rules: unknown;
  policy_effective_from: Date;
  policy_is_active: boolean;
  policy_owner_id: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (!ownKeys.every((key): key is string => typeof key === "string")) return false;
    const actual = ownKeys.sort();
    const sortedExpected = [...expected].sort();
    return (
      actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index])
    );
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isFiniteDate(value: unknown): value is Date {
  if (!(value instanceof Date)) return false;
  try {
    return Number.isFinite(Date.prototype.getTime.call(value));
  } catch {
    return false;
  }
}

const INVALID_DATA_PROPERTY = Symbol("invalid-data-property");

function ownDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : INVALID_DATA_PROPERTY;
  } catch {
    return INVALID_DATA_PROPERTY;
  }
}

function isPolicyTier(value: unknown): value is AgentPolicyTier {
  return typeof value === "string" && POLICY_TIERS.has(value);
}

function normalizeSelection(selection: WebSocialAuthoritySelection): NormalizedSelection {
  if (!isPlainRecord(selection)) {
    throw new WebSocialAuthorityError("INVALID_AUTHORITY_SELECTION");
  }
  const kind = ownDataProperty(selection, "kind");
  if (kind === "owner_direct") {
    const agentId = ownDataProperty(selection, "agentId");
    if (!hasExactKeys(selection, OWNER_DIRECT_INPUT_KEYS) || !isUuid(agentId)) {
      throw new WebSocialAuthorityError("INVALID_AUTHORITY_SELECTION");
    }
    return {
      agentId,
      kind: "owner_direct",
    };
  }
  if (kind === "human_direct") {
    const actorId = ownDataProperty(selection, "actorId");
    if (!hasExactKeys(selection, HUMAN_DIRECT_INPUT_KEYS) || !isUuid(actorId)) {
      throw new WebSocialAuthorityError("INVALID_AUTHORITY_SELECTION");
    }
    return {
      actorId,
      kind: "human_direct",
    };
  }
  throw new WebSocialAuthorityError("INVALID_AUTHORITY_SELECTION");
}

function ownerIsEligible(
  row: OwnerAuthorityRow,
  ownerId: string,
  checkedAt: Date,
): boolean {
  return (
    row.id === ownerId &&
    row.status === "active" &&
    isFiniteDate(row.email_verified_at) &&
    row.email_verified_at <= checkedAt &&
    row.deleted_at === null
  );
}

function publicRequestContext(
  context: OwnerWebMutationContext,
): WebSocialAuthorityRequestContext {
  const authenticatedAtMilliseconds = Date.prototype.getTime.call(
    context.authenticatedAt,
  );
  return Object.freeze({
    ownerId: context.ownerId,
    requestId: context.requestId,
    get authenticatedAt(): Date {
      return new Date(authenticatedAtMilliseconds);
    },
    authenticationAssurance: context.authenticationAssurance,
    csrfValidated: true,
    channel: "web",
  });
}

function actorDatesAreValid(row: HumanAuthorityRow): boolean {
  return (
    isFiniteDate(row.actor_created_at) &&
    isFiniteDate(row.actor_updated_at) &&
    row.actor_updated_at >= row.actor_created_at
  );
}

function mapActor(row: HumanAuthorityRow, kind: "agent" | "human"): WebSocialActorView {
  const createdAtMilliseconds = Date.prototype.getTime.call(row.actor_created_at);
  const updatedAtMilliseconds = Date.prototype.getTime.call(row.actor_updated_at);
  return Object.freeze({
    id: row.actor_id,
    ownerId: row.actor_owner_id,
    kind,
    handle: row.actor_handle,
    displayName: row.actor_display_name,
    bio: row.actor_bio,
    status: "active",
    get createdAt(): Date {
      return new Date(createdAtMilliseconds);
    },
    get updatedAt(): Date {
      return new Date(updatedAtMilliseconds);
    },
  });
}

function brandAndFreezeAuthority<T extends WebSocialAuthority>(
  authority: Omit<T, typeof WEB_SOCIAL_AUTHORITY_BRAND>,
): T {
  Object.defineProperty(authority, WEB_SOCIAL_AUTHORITY_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  const branded = Object.freeze(authority) as unknown as T;
  ISSUED_WEB_SOCIAL_AUTHORITIES.add(branded);
  return branded;
}

function isIssuedWebSocialAuthority(value: unknown): value is WebSocialAuthority {
  if (typeof value !== "object" || value === null) return false;
  if (!ISSUED_WEB_SOCIAL_AUTHORITIES.has(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, WEB_SOCIAL_AUTHORITY_BRAND);
  return (
    descriptor?.value === true &&
    descriptor.configurable === false &&
    descriptor.enumerable === false &&
    descriptor.writable === false &&
    Object.isFrozen(value)
  );
}

function flatRulesMatch(
  value: Record<string, unknown>,
  expected: Record<AgentPolicyRuleKey, AgentPolicyDecision>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === AGENT_POLICY_RULE_KEYS.length &&
    keys.every((key) => POLICY_RULE_KEY_SET.has(key)) &&
    AGENT_POLICY_RULE_KEYS.every((key) => value[key] === expected[key])
  );
}

/**
 * PostgreSQL constrains these documents, but the resolver still treats every
 * row as untrusted input. This prevents a corrupted standard-tier row from
 * silently discarding an unexpected rule during materialization.
 */
function parseStrictPersistedPolicyRules(
  tier: AgentPolicyTier,
  value: unknown,
): AgentPolicyRules | null {
  if (!isPlainRecord(value)) return null;
  if (tier === "custom") return parsePersistedAgentPolicyRules(tier, value);
  if (Object.keys(value).length === 0) return { operations: {} };
  if (tier === "assisted" && flatRulesMatch(value, LEGACY_ASSISTED_RULES)) {
    return { operations: {} };
  }
  return null;
}

function buildHumanAuthority(
  selection: NormalizedHumanDirectSelection,
  row: HumanAuthorityRow,
  ownerId: string,
  requestContext: WebSocialAuthorityRequestContext,
  checkedAt: Date,
): HumanDirectAuthority | null {
  if (
    row.actor_id !== selection.actorId ||
    row.actor_owner_id !== ownerId ||
    row.actor_kind !== "human" ||
    row.actor_status !== "active" ||
    row.actor_deleted_at !== null ||
    !actorDatesAreValid(row)
  ) {
    return null;
  }
  const actor = mapActor(row, "human") as HumanDirectAuthority["actor"];
  const checkedAtMilliseconds = checkedAt.valueOf();
  return brandAndFreezeAuthority<HumanDirectAuthority>({
    kind: "human_direct",
    owner: Object.freeze({ id: ownerId }),
    actor,
    agent: null,
    currentPolicy: null,
    credential: null,
    channel: "web",
    approvalMethod: "human_direct",
    principalScopeKey: `human_web:${ownerId}:${selection.actorId}`,
    requestContext,
    get authorityCheckedAt(): Date {
      return new Date(checkedAtMilliseconds);
    },
  });
}

function buildAgentAuthority(
  selection: NormalizedOwnerDirectSelection,
  row: AgentAuthorityRow,
  ownerId: string,
  requestContext: WebSocialAuthorityRequestContext,
  checkedAt: Date,
): OwnerDirectAgentAuthority | null {
  const tier = isPolicyTier(row.policy_tier) ? row.policy_tier : null;
  const persistedRules = tier
    ? parseStrictPersistedPolicyRules(tier, row.policy_rules)
    : null;
  if (
    row.agent_id !== selection.agentId ||
    row.agent_owner_id !== ownerId ||
    row.agent_status !== "active" ||
    row.agent_deleted_at !== null ||
    !isFiniteDate(row.agent_created_at) ||
    !isFiniteDate(row.agent_updated_at) ||
    row.agent_updated_at < row.agent_created_at ||
    !isFiniteDate(row.agent_activated_at) ||
    row.agent_activated_at > checkedAt ||
    row.agent_archived_at !== null ||
    row.actor_id !== row.agent_actor_id ||
    row.actor_owner_id !== ownerId ||
    row.actor_kind !== "agent" ||
    row.actor_status !== "active" ||
    row.actor_deleted_at !== null ||
    !actorDatesAreValid(row) ||
    row.policy_agent_id !== selection.agentId ||
    row.policy_owner_id !== ownerId ||
    row.policy_is_active !== true ||
    !isUuid(row.policy_id) ||
    !tier ||
    !Number.isInteger(row.policy_schema_version) ||
    !isFiniteDate(row.policy_effective_from) ||
    row.policy_effective_from > checkedAt ||
    !persistedRules ||
    !Array.isArray(row.agent_discovery_tags) ||
    !row.agent_discovery_tags.every((tag) => typeof tag === "string") ||
    !Number.isSafeInteger(row.agent_credential_count) ||
    row.agent_credential_count < 0
  ) {
    return null;
  }

  const policyEffectiveFromMilliseconds = Date.prototype.getTime.call(
    row.policy_effective_from,
  );
  const materializedOperations = Object.freeze(
    materializeAgentPolicyRules(tier, persistedRules),
  );
  const currentPolicy: WebSocialAgentPolicyView = Object.freeze({
    id: row.policy_id,
    tier,
    defaultsVersion: row.policy_defaults_version,
    schemaVersion: row.policy_schema_version,
    version: row.policy_version,
    get effectiveFrom(): Date {
      return new Date(policyEffectiveFromMilliseconds);
    },
    rules: Object.freeze({
      operations: materializedOperations,
    }),
  });
  const actor = mapActor(row, "agent") as OwnerDirectAgentAuthority["actor"];
  const agentCreatedAtMilliseconds = Date.prototype.getTime.call(row.agent_created_at);
  const agentUpdatedAtMilliseconds = Date.prototype.getTime.call(row.agent_updated_at);
  const agentActivatedAtMilliseconds = Date.prototype.getTime.call(
    row.agent_activated_at,
  );
  const agent: WebSocialOwnerAgentView = Object.freeze({
    id: row.agent_id,
    actorId: row.agent_actor_id,
    ownerId: row.agent_owner_id,
    handle: row.actor_handle,
    displayName: row.actor_display_name,
    bio: row.actor_bio,
    discoveryTags: Object.freeze([...row.agent_discovery_tags]),
    status: "active",
    restrictionReasonCode: row.agent_restriction_reason_code,
    credentialCount: row.agent_credential_count,
    get createdAt(): Date {
      return new Date(agentCreatedAtMilliseconds);
    },
    get updatedAt(): Date {
      return new Date(agentUpdatedAtMilliseconds);
    },
    get activatedAt(): Date {
      return new Date(agentActivatedAtMilliseconds);
    },
    archivedAt: null,
    policy: currentPolicy,
  });
  const checkedAtMilliseconds = checkedAt.valueOf();
  return brandAndFreezeAuthority<OwnerDirectAgentAuthority>({
    kind: "owner_direct",
    owner: Object.freeze({ id: ownerId }),
    actor,
    agent,
    currentPolicy,
    credential: null,
    channel: "web",
    approvalMethod: "owner_direct",
    principalScopeKey: `owner_direct:${ownerId}:${selection.agentId}`,
    requestContext,
    get authorityCheckedAt(): Date {
      return new Date(checkedAtMilliseconds);
    },
  });
}

function policyViewsMatch(
  left: WebSocialAgentPolicyView,
  right: WebSocialAgentPolicyView,
): boolean {
  return (
    left.id === right.id &&
    left.tier === right.tier &&
    left.defaultsVersion === right.defaultsVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.version === right.version &&
    isFiniteDate(left.effectiveFrom) &&
    isFiniteDate(right.effectiveFrom) &&
    left.effectiveFrom.valueOf() === right.effectiveFrom.valueOf() &&
    JSON.stringify(left.rules) === JSON.stringify(right.rules)
  );
}

function operationRuleKey(operation: AgentOperation): AgentPolicyRuleKey | null {
  switch (operation) {
    case "get_agent_context":
      return null;
    case "find_communities":
    case "get_community":
    case "browse_content":
    case "list_follows":
      return "browse";
    case "search_content":
      return "search";
    case "get_content":
    case "get_discussion":
      return "content_read";
    case "list_notifications":
    case "get_action_status":
      return "notification_read";
    case "create_post":
      return "content_write";
    case "reply_to_content":
      return "reply_write";
    case "update_content":
      return "edit_own_content";
    case "delete_content":
      return "delete_own_content";
    case "set_reaction":
      return "reaction_write";
    case "set_follow":
      return "follow_write";
  }
}

function policyRulesForEvaluation(
  policy: WebSocialAgentPolicyView,
): AgentPolicyRules | null {
  if (
    policy.defaultsVersion !== AGENT_POLICY_DEFAULTS_VERSION ||
    policy.schemaVersion !== AGENT_POLICY_SCHEMA_VERSION ||
    !isPolicyTier(policy.tier)
  ) {
    return null;
  }
  const parsed = parseAgentPolicyRules(policy.rules);
  if (!parsed) return null;
  const actualKeys = Object.keys(parsed.operations);
  if (
    actualKeys.length !== AGENT_POLICY_RULE_KEYS.length ||
    actualKeys.some((key) => !POLICY_RULE_KEY_SET.has(key))
  ) {
    return null;
  }
  return parsed;
}

function requestContextSupportsOwnerDirect(
  authority: OwnerDirectAgentAuthority,
): boolean {
  const context = authority.requestContext;
  if (
    !isPlainRecord(context) ||
    !hasExactKeys(context, AUTHORITY_REQUEST_CONTEXT_KEYS) ||
    context.ownerId !== authority.owner.id ||
    context.channel !== "web" ||
    context.csrfValidated !== true ||
    (context.authenticationAssurance !== "owner_session" &&
      context.authenticationAssurance !== "fresh_owner_session") ||
    typeof context.requestId !== "string" ||
    context.requestId.length < 1 ||
    context.requestId.length > 200 ||
    context.requestId !== context.requestId.trim() ||
    context.requestId.includes("\0") ||
    !isFiniteDate(context.authenticatedAt) ||
    !isFiniteDate(authority.authorityCheckedAt)
  ) {
    return false;
  }
  return context.authenticatedAt <= authority.authorityCheckedAt;
}

/**
 * Applies only the current Owner policy layer to an explicit Owner Web click.
 * A pending-approval policy result is satisfied by that click, while a hard
 * policy deny remains a deny. Platform, community, quota, and abuse checks
 * remain the responsibility of the downstream write service.
 */
export function evaluateOwnerDirectOperation(
  authority: OwnerDirectAgentAuthority,
  operation: AgentOperation,
): OwnerDirectOperationEvaluation {
  if (
    !isIssuedWebSocialAuthority(authority) ||
    authority.kind !== "owner_direct" ||
    authority.channel !== "web" ||
    authority.approvalMethod !== "owner_direct" ||
    authority.credential !== null ||
    !isPlainRecord(authority.owner) ||
    !isPlainRecord(authority.actor) ||
    authority.actor.kind !== "agent" ||
    !isPlainRecord(authority.agent) ||
    authority.owner.id !== authority.actor.ownerId ||
    authority.owner.id !== authority.agent.ownerId ||
    authority.actor.id !== authority.agent.actorId ||
    authority.actor.status !== "active" ||
    authority.agent.status !== "active" ||
    authority.principalScopeKey !==
      `owner_direct:${authority.owner.id}:${authority.agent.id}` ||
    !requestContextSupportsOwnerDirect(authority) ||
    !OPERATION_SET.has(operation) ||
    !policyViewsMatch(authority.currentPolicy, authority.agent.policy)
  ) {
    return {
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    };
  }
  const rules = policyRulesForEvaluation(authority.currentPolicy);
  if (!rules) {
    return {
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    };
  }
  const ruleKey = operationRuleKey(operation);
  const ownerPolicyDecision = ruleKey ? rules.operations[ruleKey] : "allow";
  if (!ownerPolicyDecision) {
    return {
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision: "deny",
      reason: "POLICY_RULES_UNAVAILABLE",
    };
  }
  if (ownerPolicyDecision === "deny") {
    return {
      approvalSatisfied: false,
      decision: "deny",
      ownerPolicyDecision,
      reason: "POLICY_DENIED",
    };
  }
  if (ownerPolicyDecision === "require_approval") {
    return {
      approvalSatisfied: true,
      decision: "allow",
      ownerPolicyDecision,
      reason: "OWNER_DIRECT_APPROVAL_SATISFIED",
    };
  }
  return {
    approvalSatisfied: false,
    decision: "allow",
    ownerPolicyDecision,
    reason: "ALLOWED_BY_POLICY",
  };
}

export class PostgresWebSocialAuthorityResolver implements WebSocialAuthorityResolver {
  readonly #contextVerifier: OwnerWebContextVerifier;
  readonly #sql: PostgresClient;

  constructor(sql: PostgresClient, contextVerifier: OwnerWebContextVerifier) {
    this.#sql = sql;
    this.#contextVerifier = contextVerifier;
  }

  async checkReady(): Promise<void> {
    const rows = await this.#sql.begin(async (transaction) => {
      await transaction`set local statement_timeout = '1500ms'`;
      return transaction<{ ready: boolean }[]>`
        select
          exists (
            select 1
            from system.schema_migrations
            where version = '000021'
              and name = 'owner_web_social_v1'
              and checksum = ${OWNER_WEB_SOCIAL_V1_MIGRATION_CHECKSUM}
          )
          and to_regprocedure(
            'platform.validate_domain_write_subject()'
          ) is not null
          and to_regprocedure(
            'platform.validate_runtime_content_write_provenance()'
          ) is not null
          and exists (
            select 1
            from pg_catalog.pg_trigger
            where tgrelid = to_regclass('platform.action_logs')
              and tgname = 'action_logs_validate_domain_write_subject'
              and tgfoid = to_regprocedure(
                'platform.validate_domain_write_subject()'
              )
              and not tgisinternal
              and tgenabled in ('O', 'A')
          )
          and (
            select count(*) = 7
            from pg_catalog.pg_trigger as provenance_trigger
            join (
              values
                (
                  to_regclass('platform.content_items'),
                  'content_items_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.content_additional_communities'),
                  'content_additional_communities_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.content_symbols'),
                  'content_symbols_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.content_topics'),
                  'content_topics_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.source_links'),
                  'source_links_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.content_relations'),
                  'content_relations_validate_runtime_provenance'
                ),
                (
                  to_regclass('platform.mentions'),
                  'mentions_validate_runtime_provenance'
                )
            ) as expected_trigger(relation_id, trigger_name)
              on provenance_trigger.tgrelid = expected_trigger.relation_id
             and provenance_trigger.tgname = expected_trigger.trigger_name
            where not provenance_trigger.tgisinternal
              and provenance_trigger.tgenabled in ('O', 'A')
              and provenance_trigger.tgdeferrable
              and provenance_trigger.tginitdeferred
              and provenance_trigger.tgfoid = to_regprocedure(
                'platform.validate_runtime_content_write_provenance()'
              )
          ) as ready
      `;
    });
    if (rows[0]?.ready !== true) {
      throw new WebSocialAuthorityError("SCHEMA_NOT_READY");
    }
  }

  /**
   * Resolves and locks authority inside the caller's write transaction. The
   * downstream mutation must use the same transaction so the Owner, Actor,
   * Agent, and policy locks remain held through commit.
   */
  resolveAuthorityInTransaction(
    transaction: postgres.TransactionSql,
    rawContext: OwnerWebMutationContext,
    rawSelection: WebSocialAuthoritySelection,
  ): Promise<WebSocialAuthority> {
    return this.#resolveNormalizedAuthority(
      transaction,
      rawContext,
      normalizeSelection(rawSelection),
    );
  }

  async #resolveNormalizedAuthority(
    transaction: postgres.TransactionSql,
    rawContext: OwnerWebMutationContext,
    selection: NormalizedSelection,
  ): Promise<WebSocialAuthority> {
    const authorityTimes = await transaction<AuthorityTimeRow[]>`
      select statement_timestamp() as authority_checked_at
    `;
    const authorityCheckedAt = authorityTimes[0]?.authority_checked_at;
    if (authorityCheckedAt === undefined) {
      throw new OwnerWebSessionContextError("INVALID_DATABASE_CHECKED_AT");
    }
    const context = this.#contextVerifier.normalizeMutationContext(
      rawContext,
      authorityCheckedAt,
    );
    const requestContext = publicRequestContext(context);

    const owners = await transaction<OwnerAuthorityRow[]>`
        select
          owner.id,
          owner.status,
          owner.email_verified_at,
          owner.deleted_at
        from platform.owners as owner
        where owner.id = ${context.ownerId}
        for share of owner
      `;
    const owner = owners[0];
    if (!owner || !ownerIsEligible(owner, context.ownerId, authorityCheckedAt)) {
      throw new WebSocialAuthorityError("OWNER_NOT_ELIGIBLE");
    }

    if (selection.kind === "human_direct") {
      const actors = await transaction<HumanAuthorityRow[]>`
          select
            actor.id as actor_id,
            actor.owner_id as actor_owner_id,
            actor.kind as actor_kind,
            actor.handle::text as actor_handle,
            actor.display_name as actor_display_name,
            actor.bio as actor_bio,
            actor.status as actor_status,
            actor.created_at as actor_created_at,
            actor.updated_at as actor_updated_at,
            actor.deleted_at as actor_deleted_at
          from platform.actors as actor
          where actor.id = ${selection.actorId}
          for share of actor
        `;
      const authority = actors[0]
        ? buildHumanAuthority(
            selection,
            actors[0],
            context.ownerId,
            requestContext,
            authorityCheckedAt,
          )
        : null;
      if (!authority) throw new WebSocialAuthorityError("AUTHORITY_NOT_FOUND");
      return authority;
    }

    const rows = await transaction<AgentAuthorityRow[]>`
        select
          agent.id as agent_id,
          agent.actor_id as agent_actor_id,
          agent.owner_id as agent_owner_id,
          agent.discovery_tags as agent_discovery_tags,
          agent.status as agent_status,
          agent.restriction_reason_code as agent_restriction_reason_code,
          (
            select count(*)::integer
            from platform.credentials as credential_count_source
            where credential_count_source.agent_id = agent.id
          ) as agent_credential_count,
          agent.created_at as agent_created_at,
          agent.updated_at as agent_updated_at,
          agent.activated_at as agent_activated_at,
          agent.archived_at as agent_archived_at,
          agent.deleted_at as agent_deleted_at,
          actor.id as actor_id,
          actor.owner_id as actor_owner_id,
          actor.kind as actor_kind,
          actor.handle::text as actor_handle,
          actor.display_name as actor_display_name,
          actor.bio as actor_bio,
          actor.status as actor_status,
          actor.created_at as actor_created_at,
          actor.updated_at as actor_updated_at,
          actor.deleted_at as actor_deleted_at,
          policy.id as policy_id,
          policy.agent_id as policy_agent_id,
          policy.tier as policy_tier,
          policy.defaults_version as policy_defaults_version,
          policy.policy_schema_version as policy_schema_version,
          policy.version::text as policy_version,
          policy.rules as policy_rules,
          policy.effective_from as policy_effective_from,
          policy.is_active as policy_is_active,
          policy.configured_by_owner_id as policy_owner_id
        from platform.agents as agent
        join platform.actors as actor
          on actor.id = agent.actor_id
        join platform.agent_policies as policy
          on policy.agent_id = agent.id
         and policy.is_active
        where agent.id = ${selection.agentId}
        for share of agent, actor, policy
      `;
    const authority = rows[0]
      ? buildAgentAuthority(
          selection,
          rows[0],
          context.ownerId,
          requestContext,
          authorityCheckedAt,
        )
      : null;
    if (!authority) throw new WebSocialAuthorityError("AUTHORITY_NOT_FOUND");
    return authority;
  }
}
