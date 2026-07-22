import {
  OidcJwtVerificationError,
  type OidcJwtVerifier,
  type OidcMfaEvidence,
  type VerifiedOidcJwtIdentity,
} from "@alphanet/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

import { v1Error } from "./agent-routes.js";

export const ADMIN_PERMISSIONS = [
  "moderation:read",
  "moderation:decide",
  "identity:restrict",
  "identity:quota_manage",
  "credential:revoke",
  "community:manage",
  "audit:read",
  "admin:role_assign",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export type AdminRequestMode = "mutation" | "read";

export interface AdminRequestLimitRule {
  max: number;
  window: number;
}

export interface AdminRequestRateLimiter {
  consume(
    key: string,
    rule: AdminRequestLimitRule,
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

export interface ActiveAdminAuthorizationSnapshot {
  adminId: string;
  permissions: readonly AdminPermission[];
  roles: readonly string[];
}

export interface AdminAuthorizationRepository {
  /**
   * Resolves the active Admin, unexpired/unrevoked assignments, active roles,
   * and effective atomic permissions in one current database read. The boundary
   * intentionally performs this lookup on every request and does not cache RBAC.
   */
  resolveActiveAuthorization(identity: {
    issuer: string;
    subject: string;
  }): Promise<ActiveAdminAuthorizationSnapshot | null>;
}

export type AdminSecurityRejectionReason =
  "admin_not_active" | "admin_permission_required";

export interface AdminSecurityRejection {
  adminId: string | null;
  authenticationAssurance: "workforce_oidc";
  authorizationSnapshot: {
    permission: AdminPermission;
    permissions: readonly AdminPermission[];
    roles: readonly string[];
  } | null;
  channel: "admin_web";
  eventClass: "security_rejection";
  /**
   * Sensitive verified identifiers for the audit adapter to convert to its
   * keyed security_subject_digest. They must not be copied into application logs.
   */
  identity: {
    issuer: string;
    subject: string;
  };
  permission: AdminPermission;
  reasonCode: AdminSecurityRejectionReason;
  requestId: string;
}

export interface AdminSecurityAudit {
  recordSecurityRejection(event: AdminSecurityRejection): Promise<void>;
}

/** Fully wired dependencies required before the Admin API may be enabled. */
export interface AdminRequestRuntime {
  audit: AdminSecurityAudit;
  identityVerifier: OidcJwtVerifier;
  limits?:
    | {
        mutation?: AdminRequestLimitRule | undefined;
        read?: AdminRequestLimitRule | undefined;
      }
    | undefined;
  rateLimiter: AdminRequestRateLimiter;
  repository: AdminAuthorizationRepository;
  resolveClientIp?: ((request: FastifyRequest) => string) | undefined;
}

export interface AdminRequestBoundaryOptions extends AdminRequestRuntime {
  mode: AdminRequestMode;
  permission: AdminPermission;
}

export interface AuthorizedAdminRequest {
  adminId: string;
  authenticationAssurance: "workforce_oidc";
  mfa: OidcMfaEvidence;
  permission: AdminPermission;
  permissions: readonly AdminPermission[];
  roles: readonly string[];
}

export interface AdminRequestAuthorizationBoundary {
  readonly getAuthorization: (request: FastifyRequest) => AuthorizedAdminRequest;
  readonly onRequest: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

export const DEFAULT_ADMIN_REQUEST_LIMITS = {
  mutation: { max: 20, window: 60 },
  read: { max: 120, window: 60 },
} as const satisfies Record<AdminRequestMode, AdminRequestLimitRule>;

const adminPermissionSet = new Set<string>(ADMIN_PERMISSIONS);
const bearerJwtPattern = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const queryCredentialNames = new Set(["access_token", "api_key", "id_token", "token"]);
const roleKeyPattern = /^[a-z][a-z0-9._-]{0,79}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validLimitRule(rule: AdminRequestLimitRule): boolean {
  return (
    Number.isInteger(rule.max) &&
    rule.max >= 1 &&
    rule.max <= 10_000 &&
    Number.isInteger(rule.window) &&
    rule.window >= 1 &&
    rule.window <= 86_400
  );
}

function validateBoundaryOptions(options: AdminRequestBoundaryOptions): void {
  if (!adminPermissionSet.has(options.permission)) {
    throw new Error("Admin request permission must be a controlled atomic permission");
  }
  if (options.mode !== "read" && options.mode !== "mutation") {
    throw new Error("Admin request mode is invalid");
  }
  for (const rule of [options.limits?.read, options.limits?.mutation]) {
    if (rule && !validLimitRule(rule)) {
      throw new Error("Admin request limit rule is invalid");
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function bearerJwt(request: FastifyRequest): string | null {
  const url = new URL(request.url, "http://alphanet.invalid");
  for (const key of url.searchParams.keys()) {
    if (queryCredentialNames.has(key.toLowerCase())) return null;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || authorization.length > 16_391) {
    return null;
  }
  return bearerJwtPattern.exec(authorization)?.[1] ?? null;
}

function sendAuthenticationRequired(
  request: FastifyRequest,
  reply: FastifyReply,
  invalidToken = false,
): void {
  void reply.header(
    "www-authenticate",
    invalidToken
      ? 'Bearer realm="alphanet-admin", error="invalid_token"'
      : 'Bearer realm="alphanet-admin"',
  );
  void reply.code(401).send(
    v1Error(request, {
      code: "AUTHENTICATION_REQUIRED",
      message: "A valid workforce OIDC Bearer token with MFA is required.",
    }),
  );
}

function sendDependencyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
): void {
  void reply.code(503).send(
    v1Error(request, {
      code: "TEMPORARILY_UNAVAILABLE",
      message,
      retryable: true,
    }),
  );
}

async function consumeLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  rateLimiter: AdminRequestRateLimiter,
  key: string,
  rule: AdminRequestLimitRule,
): Promise<boolean> {
  try {
    const result = await rateLimiter.consume(key, rule);
    if (result.allowed) return true;

    const retryAfter = Math.max(1, Math.ceil(result.retryAfter ?? rule.window));
    void reply.header("retry-after", String(retryAfter));
    void reply.code(429).send(
      v1Error(request, {
        code: "RATE_LIMITED",
        message: "Too many Admin requests were made in this time window.",
        retryable: true,
        retryAt: new Date(Date.now() + retryAfter * 1_000),
      }),
    );
    return false;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Admin request rate limiter failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Admin request protection is temporarily unavailable.",
    );
    return false;
  }
}

function normalizeAuthorizationSnapshot(
  snapshot: ActiveAdminAuthorizationSnapshot,
): ActiveAdminAuthorizationSnapshot {
  if (
    !uuidPattern.test(snapshot.adminId) ||
    !Array.isArray(snapshot.roles) ||
    snapshot.roles.length > 100 ||
    snapshot.roles.some(
      (role) => typeof role !== "string" || !roleKeyPattern.test(role),
    ) ||
    !Array.isArray(snapshot.permissions) ||
    snapshot.permissions.length > ADMIN_PERMISSIONS.length ||
    snapshot.permissions.some(
      (permission) =>
        typeof permission !== "string" || !adminPermissionSet.has(permission),
    )
  ) {
    throw new Error("Admin authorization repository returned an invalid snapshot");
  }

  return Object.freeze({
    adminId: snapshot.adminId,
    permissions: Object.freeze(
      [...new Set(snapshot.permissions)].sort() as AdminPermission[],
    ),
    roles: Object.freeze([...new Set(snapshot.roles)].sort()),
  });
}

async function auditDenial(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AdminRequestBoundaryOptions,
  identity: VerifiedOidcJwtIdentity,
  snapshot: ActiveAdminAuthorizationSnapshot | null,
  reasonCode: AdminSecurityRejectionReason,
): Promise<boolean> {
  try {
    await options.audit.recordSecurityRejection(
      Object.freeze({
        adminId: snapshot?.adminId ?? null,
        authenticationAssurance: "workforce_oidc",
        authorizationSnapshot: snapshot
          ? Object.freeze({
              permission: options.permission,
              permissions: snapshot.permissions,
              roles: snapshot.roles,
            })
          : null,
        channel: "admin_web",
        eventClass: "security_rejection",
        identity: Object.freeze({
          issuer: identity.issuer,
          subject: identity.subject,
        }),
        permission: options.permission,
        reasonCode,
        requestId: request.id,
      }),
    );
    return true;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Admin security rejection audit failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Admin authorization auditing is temporarily unavailable.",
    );
    return false;
  }
}

async function authorizeAdminRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AdminRequestBoundaryOptions,
): Promise<AuthorizedAdminRequest | null> {
  let clientIp: string;
  try {
    clientIp = options.resolveClientIp?.(request) ?? request.ip;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Admin request client address resolution failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Admin request protection is temporarily unavailable.",
    );
    return null;
  }

  const rule =
    options.limits?.[options.mode] ?? DEFAULT_ADMIN_REQUEST_LIMITS[options.mode];
  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `ip:${clientIp}:admin-api:${options.mode}`,
      rule,
    ))
  ) {
    return null;
  }

  const token = bearerJwt(request);
  if (!token) {
    sendAuthenticationRequired(request, reply);
    return null;
  }

  let identity: VerifiedOidcJwtIdentity;
  try {
    identity = await options.identityVerifier.verify(token);
  } catch (error) {
    if (error instanceof OidcJwtVerificationError && error.code === "invalid_token") {
      sendAuthenticationRequired(request, reply, true);
      return null;
    }
    request.log.error(
      { errorName: errorName(error) },
      "Admin workforce identity verification failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Admin authentication is temporarily unavailable.",
    );
    return null;
  }

  let snapshot: ActiveAdminAuthorizationSnapshot | null;
  try {
    const resolved = await options.repository.resolveActiveAuthorization({
      issuer: identity.issuer,
      subject: identity.subject,
    });
    snapshot = resolved ? normalizeAuthorizationSnapshot(resolved) : null;
  } catch (error) {
    request.log.error(
      { errorName: errorName(error) },
      "Admin authorization lookup failed",
    );
    sendDependencyUnavailable(
      request,
      reply,
      "Admin authorization is temporarily unavailable.",
    );
    return null;
  }

  if (!snapshot) {
    if (
      !(await auditDenial(request, reply, options, identity, null, "admin_not_active"))
    ) {
      return null;
    }
    void reply.code(403).send(
      v1Error(request, {
        code: "ADMIN_ACCESS_DENIED",
        message: "The workforce identity is not authorized for Admin access.",
      }),
    );
    return null;
  }

  if (
    !(await consumeLimit(
      request,
      reply,
      options.rateLimiter,
      `admin:${snapshot.adminId}:admin-api:${options.mode}`,
      rule,
    ))
  ) {
    return null;
  }

  if (!snapshot.permissions.includes(options.permission)) {
    if (
      !(await auditDenial(
        request,
        reply,
        options,
        identity,
        snapshot,
        "admin_permission_required",
      ))
    ) {
      return null;
    }
    void reply.code(403).send(
      v1Error(request, {
        code: "ADMIN_PERMISSION_REQUIRED",
        message:
          "The Admin does not have the atomic permission required for this operation.",
        details: { required_permission: options.permission },
      }),
    );
    return null;
  }

  return Object.freeze({
    adminId: snapshot.adminId,
    authenticationAssurance: "workforce_oidc",
    mfa: identity.mfa,
    permission: options.permission,
    permissions: snapshot.permissions,
    roles: snapshot.roles,
  });
}

/**
 * Parse-before Admin boundary. It trusts only a verified workforce OIDC Bearer
 * token, refreshes durable RBAC for every request, and stores authorization in
 * a request-keyed WeakMap. Owner cookies and client-provided Admin IDs are never
 * read as Admin identity or authority.
 */
export function createAdminRequestAuthorizationBoundary(
  options: AdminRequestBoundaryOptions,
): AdminRequestAuthorizationBoundary {
  validateBoundaryOptions(options);
  const authorizations = new WeakMap<FastifyRequest, AuthorizedAdminRequest>();

  return {
    getAuthorization: (request) => {
      const authorization = authorizations.get(request);
      if (!authorization) {
        throw new Error("Admin request reached its handler without authorization");
      }
      return authorization;
    },
    onRequest: async (request, reply) => {
      void reply.header("cache-control", "no-store, private");
      void reply.header("pragma", "no-cache");
      const authorization = await authorizeAdminRequest(request, reply, options);
      if (!authorization) return reply;
      authorizations.set(request, authorization);
    },
  };
}
