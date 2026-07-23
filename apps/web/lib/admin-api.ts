import {
  AdminAgentActionHeadersSchema,
  AdminAgentActionRequestSchema,
  AdminAgentActionResponseSchema,
  AdminAgentDetailResponseSchema,
  AdminAgentListRequestSchema,
  AdminAgentListResponseSchema,
  AdminAgentPathParamsSchema,
  AdminTopicCommunityCreateHeadersSchema,
  AdminTopicCommunityCreateRequestSchema,
  AdminTopicCommunityListRequestSchema,
  AdminTopicCommunityListResponseSchema,
  AdminTopicCommunityMutationResponseSchema,
  AdminTopicCommunityPatchHeadersSchema,
  AdminTopicCommunityPatchRequestSchema,
  AdminTopicCommunityPathParamsSchema,
  AdminModerationCaseDetailRequestSchema,
  AdminModerationCaseDetailResponseSchema,
  AdminModerationCaseListRequestSchema,
  AdminModerationCaseListResponseSchema,
  AdminModerationCasePathParamsSchema,
  AdminModerationDecisionHeadersSchema,
  AdminModerationDecisionRequestSchema,
  AdminModerationDecisionResponseSchema,
  V1ErrorResponseSchema,
  type AdminModerationCaseDetailRequest,
  type AdminModerationCaseDetailResponse,
  type AdminModerationCaseListRequest,
  type AdminModerationCaseListResponse,
  type AdminModerationDecisionRequest,
  type AdminModerationDecisionResponse,
  type AdminAgentActionRequest,
  type AdminAgentActionResponse,
  type AdminAgentDetailResponse,
  type AdminAgentListRequest,
  type AdminAgentListResponse,
  type AdminTopicCommunityCreateRequest,
  type AdminTopicCommunityListRequest,
  type AdminTopicCommunityListResponse,
  type AdminTopicCommunityMutationResponse,
  type AdminTopicCommunityPatchRequest,
  type V1ErrorResponse,
} from "@alphanet/contracts";
import { cookies, headers } from "next/headers";

import { getAdminSessionStore, type AdminSessionStore } from "./admin-session-store";
import { loadAdminWebConfig, type AdminWebConfig } from "./admin-web-config";
import { signedSsrClientIpHeaders } from "./ssr-client-ip";

const ADMIN_API_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const ADMIN_API_TIMEOUT_MILLISECONDS = 8_000;
const DEFAULT_API_INTERNAL_URL = "http://localhost:4000";
const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ResponseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export interface AdminApiSafeError {
  code: string;
  currentVersion: number | null;
  requestId: string;
  requiredPermission:
    | "community:manage"
    | "credential:revoke"
    | "identity:restrict"
    | "moderation:decide"
    | "moderation:read"
    | null;
  retryAfterMs: number | null;
}

type AdminApiFailure =
  | { kind: "disabled" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; error: AdminApiSafeError }
  | { kind: "not_found"; error: AdminApiSafeError }
  | { kind: "invalid"; error: AdminApiSafeError | null }
  | { kind: "conflict"; error: AdminApiSafeError }
  | {
      kind: "rate_limited";
      error: AdminApiSafeError;
      retryAfterMs: number;
    }
  | { kind: "unavailable"; error: AdminApiSafeError | null };

export type AdminApiResult<T> =
  { kind: "success"; data: T; status: 200 | 201 } | AdminApiFailure;

export interface AdminModerationDecisionInput {
  attemptId: string;
  caseId: string;
  caseVersion: number;
  decision: AdminModerationDecisionRequest;
}

export interface AdminAgentActionInput {
  action: AdminAgentActionRequest;
  agentId: string;
  agentVersion: number;
  attemptId: string;
}

export interface AdminTopicCommunityCreateInput {
  attemptId: string;
  community: AdminTopicCommunityCreateRequest;
}

export interface AdminTopicCommunityUpdateInput {
  attemptId: string;
  communityId: string;
  communityVersion: number;
  patch: AdminTopicCommunityPatchRequest;
}

export interface AdminApiClient {
  actOnAgent(
    input: AdminAgentActionInput,
  ): Promise<AdminApiResult<AdminAgentActionResponse>>;
  createTopicCommunity(
    input: AdminTopicCommunityCreateInput,
  ): Promise<AdminApiResult<AdminTopicCommunityMutationResponse>>;
  decideCase(
    input: AdminModerationDecisionInput,
  ): Promise<AdminApiResult<AdminModerationDecisionResponse>>;
  getCase(
    caseId: string,
    request?: AdminModerationCaseDetailRequest,
  ): Promise<AdminApiResult<AdminModerationCaseDetailResponse>>;
  getAgent(agentId: string): Promise<AdminApiResult<AdminAgentDetailResponse>>;
  listAgents(
    request?: AdminAgentListRequest,
  ): Promise<AdminApiResult<AdminAgentListResponse>>;
  listCases(
    request?: AdminModerationCaseListRequest,
  ): Promise<AdminApiResult<AdminModerationCaseListResponse>>;
  listTopicCommunities(
    request?: AdminTopicCommunityListRequest,
  ): Promise<AdminApiResult<AdminTopicCommunityListResponse>>;
  updateTopicCommunity(
    input: AdminTopicCommunityUpdateInput,
  ): Promise<AdminApiResult<AdminTopicCommunityMutationResponse>>;
}

export interface AdminApiClientDependencies {
  adminConfig: AdminWebConfig;
  apiInternalUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  incomingHeaders: Headers;
  now?: (() => number) | undefined;
  sessionHandle: string | null;
  sessionStore?: AdminSessionStore | undefined;
  signClientIpHeaders?: typeof signedSsrClientIpHeaders | undefined;
  timeoutSignal?: ((milliseconds: number) => AbortSignal) | undefined;
}

interface ParsedAdminModerationDecisionInput {
  caseId: string;
  decision: AdminModerationDecisionRequest;
  headers: {
    "idempotency-key": string;
    "if-match": string;
  };
}

function unavailable(error: AdminApiSafeError | null = null): AdminApiFailure {
  return { error, kind: "unavailable" };
}

function normalizeApiInternalUrl(raw: string | undefined): string | null {
  const candidate = raw?.trim() || DEFAULT_API_INTERNAL_URL;
  if (candidate.length > 2_048) return null;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function listCasesPath(request: AdminModerationCaseListRequest): string {
  const parameters = new URLSearchParams();
  if (request.statuses !== undefined) {
    parameters.set("statuses", request.statuses.join(","));
  }
  if (request.priorities !== undefined) {
    parameters.set("priorities", request.priorities.join(","));
  }
  if (request.reasons !== undefined) {
    parameters.set("reasons", request.reasons.join(","));
  }
  if (request.content_id !== undefined) {
    parameters.set("content_id", request.content_id);
  }
  if (request.limit !== undefined) parameters.set("limit", String(request.limit));
  if (request.cursor !== undefined && request.cursor !== null) {
    parameters.set("cursor", request.cursor);
  }
  const query = parameters.toString();
  return `/v1/admin/moderation/cases${query.length > 0 ? `?${query}` : ""}`;
}

function listAgentsPath(request: AdminAgentListRequest): string {
  const parameters = new URLSearchParams();
  if (request.statuses !== undefined) {
    parameters.set("statuses", request.statuses.join(","));
  }
  if (request.query !== undefined) parameters.set("query", request.query);
  if (request.limit !== undefined) parameters.set("limit", String(request.limit));
  if (request.cursor !== undefined && request.cursor !== null) {
    parameters.set("cursor", request.cursor);
  }
  const query = parameters.toString();
  return `/v1/admin/agents${query.length > 0 ? `?${query}` : ""}`;
}

function listTopicCommunitiesPath(request: AdminTopicCommunityListRequest): string {
  const parameters = new URLSearchParams();
  if (request.states !== undefined) {
    parameters.set("states", request.states.join(","));
  }
  if (request.query !== undefined) parameters.set("query", request.query);
  if (request.limit !== undefined) parameters.set("limit", String(request.limit));
  if (request.cursor !== undefined && request.cursor !== null) {
    parameters.set("cursor", request.cursor);
  }
  const query = parameters.toString();
  return `/v1/admin/topic-communities${query.length > 0 ? `?${query}` : ""}`;
}

function caseDetailPath(
  caseId: string,
  request: AdminModerationCaseDetailRequest,
): string {
  const parameters = new URLSearchParams();
  if (request.report_limit !== undefined) {
    parameters.set("report_limit", String(request.report_limit));
  }
  if (request.report_cursor !== undefined && request.report_cursor !== null) {
    parameters.set("report_cursor", request.report_cursor);
  }
  if (request.action_limit !== undefined) {
    parameters.set("action_limit", String(request.action_limit));
  }
  if (request.action_cursor !== undefined && request.action_cursor !== null) {
    parameters.set("action_cursor", request.action_cursor);
  }
  const query = parameters.toString();
  return `/v1/admin/moderation/cases/${encodeURIComponent(caseId)}${
    query.length > 0 ? `?${query}` : ""
  }`;
}

function decisionPath(caseId: string): string {
  return `/v1/admin/moderation/cases/${encodeURIComponent(caseId)}/actions`;
}

function agentPath(agentId: string): string {
  return `/v1/admin/agents/${encodeURIComponent(agentId)}`;
}

function agentActionPath(agentId: string): string {
  return `${agentPath(agentId)}/actions`;
}

function topicCommunityPath(communityId: string): string {
  return `/v1/admin/topic-communities/${encodeURIComponent(communityId)}`;
}

function parseAdminModerationDecisionInput(
  input: unknown,
): ParsedAdminModerationDecisionInput | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.attemptId !== "string" ||
    typeof candidate.caseId !== "string" ||
    typeof candidate.caseVersion !== "number" ||
    !UUID_PATTERN.test(candidate.attemptId)
  ) {
    return null;
  }
  const path = AdminModerationCasePathParamsSchema.safeParse({
    case_id: candidate.caseId,
  });
  const decision = AdminModerationDecisionRequestSchema.safeParse(candidate.decision);
  const decisionHeaders = AdminModerationDecisionHeadersSchema.safeParse({
    "idempotency-key": `moderation-decision-${candidate.attemptId}`,
    "if-match": `"${candidate.caseVersion}"`,
  });
  return path.success && decision.success && decisionHeaders.success
    ? {
        caseId: path.data.case_id,
        decision: decision.data,
        headers: decisionHeaders.data,
      }
    : null;
}

function parseAdminAgentActionInput(input: AdminAgentActionInput): {
  agentId: string;
  body: AdminAgentActionRequest;
  headers: { "idempotency-key": string; "if-match": string };
} | null {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.attemptId !== "string" ||
    !UUID_PATTERN.test(input.attemptId) ||
    typeof input.agentVersion !== "number" ||
    !Number.isSafeInteger(input.agentVersion) ||
    input.agentVersion < 1
  ) {
    return null;
  }
  const path = AdminAgentPathParamsSchema.safeParse({ agent_id: input.agentId });
  const body = AdminAgentActionRequestSchema.safeParse(input.action);
  const requestHeaders = AdminAgentActionHeadersSchema.safeParse({
    "idempotency-key": `agent-governance-${input.attemptId}`,
    "if-match": `"${input.agentVersion}"`,
  });
  return path.success && body.success && requestHeaders.success
    ? {
        agentId: path.data.agent_id,
        body: body.data,
        headers: requestHeaders.data,
      }
    : null;
}

function parseTopicCommunityCreateInput(input: AdminTopicCommunityCreateInput): {
  body: AdminTopicCommunityCreateRequest;
  headers: { "idempotency-key": string };
} | null {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.attemptId !== "string" ||
    !UUID_PATTERN.test(input.attemptId)
  ) {
    return null;
  }
  const body = AdminTopicCommunityCreateRequestSchema.safeParse(input.community);
  const headers = AdminTopicCommunityCreateHeadersSchema.safeParse({
    "idempotency-key": `topic-community-create-${input.attemptId}`,
  });
  return body.success && headers.success
    ? { body: body.data, headers: headers.data }
    : null;
}

function parseTopicCommunityUpdateInput(input: AdminTopicCommunityUpdateInput): {
  body: AdminTopicCommunityPatchRequest;
  communityId: string;
  headers: { "idempotency-key": string; "if-match": string };
} | null {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.attemptId !== "string" ||
    !UUID_PATTERN.test(input.attemptId) ||
    typeof input.communityVersion !== "number" ||
    !Number.isSafeInteger(input.communityVersion) ||
    input.communityVersion < 1
  ) {
    return null;
  }
  const path = AdminTopicCommunityPathParamsSchema.safeParse({
    community_id: input.communityId,
  });
  const body = AdminTopicCommunityPatchRequestSchema.safeParse(input.patch);
  const headers = AdminTopicCommunityPatchHeadersSchema.safeParse({
    "idempotency-key": `topic-community-update-${input.attemptId}`,
    "if-match": `"${input.communityVersion}"`,
  });
  return path.success && body.success && headers.success
    ? {
        body: body.data,
        communityId: path.data.community_id,
        headers: headers.data,
      }
    : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json") {
    throw new Error("Admin API response did not use application/json.");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      throw new Error("Admin API response length was invalid.");
    }
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > ADMIN_API_RESPONSE_LIMIT_BYTES
    ) {
      throw new Error("Admin API response exceeded the size limit.");
    }
  }

  if (!response.body) throw new Error("Admin API response body was missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    totalBytes += part.value.byteLength;
    if (totalBytes > ADMIN_API_RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Admin API response exceeded the size limit.");
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function retryAfterHeaderMilliseconds(value: string | null, now: number): number | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^[1-9][0-9]*$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1_000
      ? seconds * 1_000
      : null;
  }
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt) || retryAt <= now) return null;
  const duration = Math.ceil(retryAt - now);
  return Number.isSafeInteger(duration) ? duration : null;
}

function safeError(
  envelope: V1ErrorResponse,
  response: Response,
  now: number,
): AdminApiSafeError {
  const details = envelope.error.details;
  const currentVersion = safePositiveInteger(details?.current_version);
  const permission = details?.required_permission;
  const requiredPermission =
    permission === "community:manage" ||
    permission === "credential:revoke" ||
    permission === "identity:restrict" ||
    permission === "moderation:read" ||
    permission === "moderation:decide"
      ? permission
      : null;
  const bodyRetryAfter = safePositiveInteger(envelope.error.retry_after_ms);
  const headerRetryAfter = retryAfterHeaderMilliseconds(
    response.headers.get("retry-after"),
    now,
  );
  const retryAfterMs =
    bodyRetryAfter === null && headerRetryAfter === null
      ? null
      : Math.max(bodyRetryAfter ?? 0, headerRetryAfter ?? 0);
  return Object.freeze({
    code: envelope.error.code,
    currentVersion,
    requestId: envelope.request_id,
    requiredPermission,
    retryAfterMs,
  });
}

function failedResult(
  response: Response,
  envelope: V1ErrorResponse,
  now: number,
): AdminApiFailure {
  const error = safeError(envelope, response, now);
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { error, kind: "forbidden" };
  if (response.status === 404) return { error, kind: "not_found" };
  if (response.status === 400 || response.status === 422) {
    return { error, kind: "invalid" };
  }
  if (response.status === 409) return { error, kind: "conflict" };
  if (response.status === 429) {
    return {
      error,
      kind: "rate_limited",
      retryAfterMs: error.retryAfterMs ?? 1_000,
    };
  }
  return unavailable(error);
}

export function createAdminApiClient(
  dependencies: AdminApiClientDependencies,
): AdminApiClient {
  const config = dependencies.adminConfig;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const signClientIpHeaders =
    dependencies.signClientIpHeaders ?? signedSsrClientIpHeaders;
  const timeoutSignal =
    dependencies.timeoutSignal ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
  const apiBaseUrl = normalizeApiInternalUrl(
    dependencies.apiInternalUrl ?? process.env.API_INTERNAL_URL,
  );
  const store =
    config.enabled && dependencies.sessionStore === undefined
      ? getAdminSessionStore(config)
      : dependencies.sessionStore;

  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: {
      body?: string | undefined;
      headers?: Record<string, string> | undefined;
      method: "GET" | "PATCH" | "POST";
      successStatuses: readonly (200 | 201)[];
    },
  ): Promise<AdminApiResult<T>> {
    if (!config.enabled) return { kind: "disabled" };
    if (!apiBaseUrl || !store) return unavailable();
    const sessionHandle = dependencies.sessionHandle;
    if (!sessionHandle || !SESSION_HANDLE_PATTERN.test(sessionHandle)) {
      return { kind: "unauthenticated" };
    }

    let session;
    try {
      session = await store.getSession(sessionHandle);
    } catch {
      return unavailable();
    }
    if (!session) return { kind: "unauthenticated" };

    let signedHeaders: Record<string, string>;
    try {
      signedHeaders = signClientIpHeaders(dependencies.incomingHeaders, {
        method: init.method,
        url: path,
      });
    } catch {
      return unavailable();
    }

    const requestHeaders = new Headers(signedHeaders);
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      requestHeaders.set(name, value);
    }
    requestHeaders.set("accept", "application/json");
    requestHeaders.set("authorization", `Bearer ${session.accessToken}`);
    if (init.body !== undefined) {
      requestHeaders.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetchImplementation(`${apiBaseUrl}${path}`, {
        ...(init.body === undefined ? {} : { body: init.body }),
        cache: "no-store",
        credentials: "omit",
        headers: requestHeaders,
        method: init.method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: timeoutSignal(ADMIN_API_TIMEOUT_MILLISECONDS),
      });
    } catch {
      return unavailable();
    }

    if (response.status === 401) {
      await store.deleteSession(sessionHandle).catch(() => undefined);
      return { kind: "unauthenticated" };
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch {
      return unavailable();
    }
    if (response.ok) {
      if (
        (response.status !== 200 && response.status !== 201) ||
        !init.successStatuses.includes(response.status)
      ) {
        return unavailable();
      }
      const parsed = schema.safeParse(payload);
      return parsed.success
        ? {
            data: parsed.data,
            kind: "success",
            status: response.status,
          }
        : unavailable();
    }

    const parsedError = V1ErrorResponseSchema.safeParse(payload);
    return parsedError.success
      ? failedResult(response, parsedError.data, now())
      : unavailable();
  }

  const client: AdminApiClient = {
    actOnAgent: async (input) => {
      const parsed = parseAdminAgentActionInput(input);
      if (!parsed) return { error: null, kind: "invalid" };
      const result = await request(
        agentActionPath(parsed.agentId),
        AdminAgentActionResponseSchema,
        {
          body: JSON.stringify(parsed.body),
          headers: parsed.headers,
          method: "POST",
          successStatuses: [200, 201],
        },
      );
      return result.kind === "success" && result.data.agent.agent_id !== parsed.agentId
        ? unavailable()
        : result;
    },
    createTopicCommunity: async (input) => {
      const parsed = parseTopicCommunityCreateInput(input);
      if (!parsed) return { error: null, kind: "invalid" };
      const result = await request(
        "/v1/admin/topic-communities",
        AdminTopicCommunityMutationResponseSchema,
        {
          body: JSON.stringify(parsed.body),
          headers: parsed.headers,
          method: "POST",
          successStatuses: [200, 201],
        },
      );
      return result.kind === "success" && result.data.community.slug !== parsed.body.slug
        ? unavailable()
        : result;
    },
    decideCase: async (input) => {
      const parsed = parseAdminModerationDecisionInput(input);
      if (!parsed) {
        return { error: null, kind: "invalid" };
      }
      const requestPath = decisionPath(parsed.caseId);
      const result = await request(requestPath, AdminModerationDecisionResponseSchema, {
        body: JSON.stringify(parsed.decision),
        headers: parsed.headers,
        method: "POST",
        successStatuses: [200, 201],
      });
      return result.kind === "success" && result.data.case.case_id !== parsed.caseId
        ? unavailable()
        : result;
    },
    getCase: async (caseId, candidate = {}) => {
      const path = AdminModerationCasePathParamsSchema.safeParse({ case_id: caseId });
      const requestData = AdminModerationCaseDetailRequestSchema.safeParse(candidate);
      if (!path.success || !requestData.success) {
        return { error: null, kind: "invalid" };
      }
      const result = await request(
        caseDetailPath(path.data.case_id, requestData.data),
        AdminModerationCaseDetailResponseSchema,
        { method: "GET", successStatuses: [200] },
      );
      return result.kind === "success" && result.data.case.case_id !== path.data.case_id
        ? unavailable()
        : result;
    },
    getAgent: async (agentId) => {
      const path = AdminAgentPathParamsSchema.safeParse({ agent_id: agentId });
      if (!path.success) return { error: null, kind: "invalid" };
      const result = await request(
        agentPath(path.data.agent_id),
        AdminAgentDetailResponseSchema,
        { method: "GET", successStatuses: [200] },
      );
      return result.kind === "success" &&
        result.data.agent.agent_id !== path.data.agent_id
        ? unavailable()
        : result;
    },
    listAgents: async (candidate = {}) => {
      const requestData = AdminAgentListRequestSchema.safeParse(candidate);
      if (!requestData.success) return { error: null, kind: "invalid" };
      return request(listAgentsPath(requestData.data), AdminAgentListResponseSchema, {
        method: "GET",
        successStatuses: [200],
      });
    },
    listCases: async (candidate = {}) => {
      const requestData = AdminModerationCaseListRequestSchema.safeParse(candidate);
      if (!requestData.success) return { error: null, kind: "invalid" };
      const result = await request(
        listCasesPath(requestData.data),
        AdminModerationCaseListResponseSchema,
        { method: "GET", successStatuses: [200] },
      );
      return result.kind === "success" &&
        requestData.data.content_id !== undefined &&
        result.data.items.some((item) => item.content_id !== requestData.data.content_id)
        ? unavailable()
        : result;
    },
    listTopicCommunities: async (candidate = {}) => {
      const requestData = AdminTopicCommunityListRequestSchema.safeParse(candidate);
      if (!requestData.success) return { error: null, kind: "invalid" };
      return request(
        listTopicCommunitiesPath(requestData.data),
        AdminTopicCommunityListResponseSchema,
        { method: "GET", successStatuses: [200] },
      );
    },
    updateTopicCommunity: async (input) => {
      const parsed = parseTopicCommunityUpdateInput(input);
      if (!parsed) return { error: null, kind: "invalid" };
      const result = await request(
        topicCommunityPath(parsed.communityId),
        AdminTopicCommunityMutationResponseSchema,
        {
          body: JSON.stringify(parsed.body),
          headers: parsed.headers,
          method: "PATCH",
          successStatuses: [200, 201],
        },
      );
      return result.kind === "success" && result.data.community.id !== parsed.communityId
        ? unavailable()
        : result;
    },
  };
  return Object.freeze(client);
}

async function defaultAdminApiClient(): Promise<AdminApiClient | null> {
  try {
    const config = loadAdminWebConfig();
    if (!config.enabled) {
      return createAdminApiClient({
        adminConfig: config,
        incomingHeaders: new Headers(),
        sessionHandle: null,
      });
    }
    const [incomingHeaders, cookieStore] = await Promise.all([headers(), cookies()]);
    return createAdminApiClient({
      adminConfig: config,
      incomingHeaders,
      sessionHandle: cookieStore.get(config.sessionCookieName)?.value ?? null,
    });
  } catch {
    return null;
  }
}

export async function listAdminModerationCases(
  request: AdminModerationCaseListRequest = {},
): Promise<AdminApiResult<AdminModerationCaseListResponse>> {
  if (!AdminModerationCaseListRequestSchema.safeParse(request).success) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.listCases(request) : unavailable();
}

export async function listAdminAgents(
  request: AdminAgentListRequest = {},
): Promise<AdminApiResult<AdminAgentListResponse>> {
  if (!AdminAgentListRequestSchema.safeParse(request).success) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.listAgents(request) : unavailable();
}

export async function getAdminAgent(
  agentId: string,
): Promise<AdminApiResult<AdminAgentDetailResponse>> {
  if (!AdminAgentPathParamsSchema.safeParse({ agent_id: agentId }).success) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.getAgent(agentId) : unavailable();
}

export async function actOnAdminAgent(
  input: AdminAgentActionInput,
): Promise<AdminApiResult<AdminAgentActionResponse>> {
  if (!parseAdminAgentActionInput(input)) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.actOnAgent(input) : unavailable();
}

export async function getAdminModerationCase(
  caseId: string,
  request: AdminModerationCaseDetailRequest = {},
): Promise<AdminApiResult<AdminModerationCaseDetailResponse>> {
  if (
    !AdminModerationCasePathParamsSchema.safeParse({ case_id: caseId }).success ||
    !AdminModerationCaseDetailRequestSchema.safeParse(request).success
  ) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.getCase(caseId, request) : unavailable();
}

export async function decideAdminModerationCase(
  input: AdminModerationDecisionInput,
): Promise<AdminApiResult<AdminModerationDecisionResponse>> {
  if (!parseAdminModerationDecisionInput(input)) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  if (!client) return unavailable();
  return client.decideCase(input);
}

export async function listAdminTopicCommunities(
  request: AdminTopicCommunityListRequest = {},
): Promise<AdminApiResult<AdminTopicCommunityListResponse>> {
  if (!AdminTopicCommunityListRequestSchema.safeParse(request).success) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.listTopicCommunities(request) : unavailable();
}

export async function createAdminTopicCommunity(
  input: AdminTopicCommunityCreateInput,
): Promise<AdminApiResult<AdminTopicCommunityMutationResponse>> {
  if (!parseTopicCommunityCreateInput(input)) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.createTopicCommunity(input) : unavailable();
}

export async function updateAdminTopicCommunity(
  input: AdminTopicCommunityUpdateInput,
): Promise<AdminApiResult<AdminTopicCommunityMutationResponse>> {
  if (!parseTopicCommunityUpdateInput(input)) {
    return { error: null, kind: "invalid" };
  }
  const client = await defaultAdminApiClient();
  return client ? client.updateTopicCommunity(input) : unavailable();
}
