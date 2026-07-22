import { createHmac } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";

import {
  ADMIN_PERMISSIONS,
  type ActiveAdminAuthorizationSnapshot,
  type AdminAuthorizationRepository,
  type AdminPermission,
  type AdminSecurityAudit,
  type AdminSecurityRejection,
} from "./admin-request.js";

const ADMIN_SECURITY_SUBJECT_DIGEST_DOMAIN = "alphanet.admin.security-subject-digest.v1";
const ADMIN_SECURITY_AUDIT_ACTION = "admin.request.authorize";
const ADMIN_SECURITY_AUDIT_TARGET_TYPE = "admin_permission";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/u;
const ISSUER_WHITESPACE_PATTERN = /\s/u;
const permissionSet = new Set<string>(ADMIN_PERMISSIONS);

interface AdminAuthorizationRow {
  admin_id: string;
  permissions: string[];
  roles: string[];
}

interface ActionLogInsertRow {
  id: string;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function assertOidcIdentity(identity: { issuer: string; subject: string }): void {
  if (
    typeof identity.issuer !== "string" ||
    identity.issuer.length < 1 ||
    identity.issuer.length > 2_048 ||
    Buffer.byteLength(identity.issuer, "utf8") > 4_096 ||
    containsControlCharacter(identity.issuer) ||
    ISSUER_WHITESPACE_PATTERN.test(identity.issuer)
  ) {
    throw new TypeError("Admin OIDC issuer is invalid");
  }
  if (
    typeof identity.subject !== "string" ||
    identity.subject.length < 1 ||
    identity.subject.length > 512 ||
    Buffer.byteLength(identity.subject, "utf8") > 2_048 ||
    containsControlCharacter(identity.subject)
  ) {
    throw new TypeError("Admin OIDC subject is invalid");
  }
}

function normalizeRoles(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((role) => typeof role !== "string" || !ROLE_KEY_PATTERN.test(role))
  ) {
    throw new TypeError("Admin authorization query returned invalid roles");
  }

  const roles = [...new Set(value as string[])].sort();
  if (roles.length > 100) {
    throw new TypeError("Admin authorization query returned too many roles");
  }
  return roles;
}

function normalizePermissions(value: unknown): AdminPermission[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (permission) => typeof permission !== "string" || !permissionSet.has(permission),
    )
  ) {
    throw new TypeError("Admin authorization query returned invalid permissions");
  }

  return [...new Set(value as AdminPermission[])].sort();
}

function normalizeAuthorizationRow(
  row: AdminAuthorizationRow,
): ActiveAdminAuthorizationSnapshot | null {
  if (typeof row.admin_id !== "string" || !UUID_PATTERN.test(row.admin_id)) {
    throw new TypeError("Admin authorization query returned an invalid Admin ID");
  }

  const roles = normalizeRoles(row.roles);
  const permissions = normalizePermissions(row.permissions);
  if (roles.length === 0 || permissions.length === 0) return null;

  return Object.freeze({
    adminId: row.admin_id,
    permissions: Object.freeze(permissions),
    roles: Object.freeze(roles),
  });
}

/**
 * Resolves workforce identity and effective RBAC from one PostgreSQL statement
 * snapshot. No authorization result is cached between Admin requests.
 */
export class PostgresAdminAuthorizationRepository implements AdminAuthorizationRepository {
  constructor(private readonly sql: PostgresClient) {}

  async resolveActiveAuthorization(identity: {
    issuer: string;
    subject: string;
  }): Promise<ActiveAdminAuthorizationSnapshot | null> {
    assertOidcIdentity(identity);

    const rows = await this.sql<AdminAuthorizationRow[]>`
      select
        admin.id::text as admin_id,
        array_agg(distinct role.key order by role.key) as roles,
        array_agg(
          distinct role_permission.permission
          order by role_permission.permission
        ) as permissions
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
      where admin.oidc_issuer = ${identity.issuer}
        and admin.oidc_subject = ${identity.subject}
        and admin.status = 'active'
      group by admin.id
      having count(distinct role_permission.permission) > 0
    `;

    if (rows.length === 0) return null;
    if (rows.length !== 1 || !rows[0]) {
      throw new Error("Admin authorization query returned an ambiguous identity");
    }
    return normalizeAuthorizationRow(rows[0]);
  }
}

function lengthFrame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function securitySubjectDigest(
  key: Buffer,
  identity: { issuer: string; subject: string },
): Buffer {
  return createHmac("sha256", key)
    .update(lengthFrame(ADMIN_SECURITY_SUBJECT_DIGEST_DOMAIN))
    .update(lengthFrame(identity.issuer))
    .update(lengthFrame(identity.subject))
    .digest();
}

function validRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 200 &&
    !containsControlCharacter(value)
  );
}

function normalizeSecurityRejection(event: AdminSecurityRejection): {
  adminId: string | null;
  authorizationSnapshot: {
    permission: AdminPermission;
    permissions: readonly AdminPermission[];
    roles: readonly string[];
  } | null;
  permission: AdminPermission;
  reasonCode: AdminSecurityRejection["reasonCode"];
  requestId: string;
} {
  if (
    event.eventClass !== "security_rejection" ||
    event.channel !== "admin_web" ||
    event.authenticationAssurance !== "workforce_oidc" ||
    !permissionSet.has(event.permission) ||
    !validRequestId(event.requestId)
  ) {
    throw new TypeError("Admin security rejection event is invalid");
  }
  assertOidcIdentity(event.identity);

  if (event.reasonCode === "admin_not_active") {
    if (event.adminId !== null || event.authorizationSnapshot !== null) {
      throw new TypeError("Inactive Admin rejection must not claim Admin authority");
    }
    return {
      adminId: null,
      authorizationSnapshot: null,
      permission: event.permission,
      reasonCode: event.reasonCode,
      requestId: event.requestId,
    };
  }

  if (
    event.reasonCode !== "admin_permission_required" ||
    typeof event.adminId !== "string" ||
    !UUID_PATTERN.test(event.adminId) ||
    event.authorizationSnapshot === null ||
    event.authorizationSnapshot.permission !== event.permission
  ) {
    throw new TypeError("Admin permission rejection authority is invalid");
  }

  const roles = normalizeRoles(event.authorizationSnapshot.roles);
  const permissions = normalizePermissions(event.authorizationSnapshot.permissions);
  if (roles.length === 0 || permissions.includes(event.permission)) {
    throw new TypeError("Admin permission rejection snapshot is inconsistent");
  }

  return {
    adminId: event.adminId,
    authorizationSnapshot: Object.freeze({
      permission: event.permission,
      permissions: Object.freeze(permissions),
      roles: Object.freeze(roles),
    }),
    permission: event.permission,
    reasonCode: event.reasonCode,
    requestId: event.requestId,
  };
}

/** Persists only a keyed digest of the verified workforce subject. */
export class PostgresAdminSecurityAudit implements AdminSecurityAudit {
  readonly #subjectDigestKey: Buffer;

  constructor(
    private readonly sql: PostgresClient,
    subjectDigestKey: Uint8Array,
  ) {
    if (!(subjectDigestKey instanceof Uint8Array) || subjectDigestKey.byteLength < 32) {
      throw new TypeError("Admin security subject digest key must contain 32+ bytes");
    }
    this.#subjectDigestKey = Buffer.from(subjectDigestKey);
  }

  async recordSecurityRejection(event: AdminSecurityRejection): Promise<void> {
    const normalized = normalizeSecurityRejection(event);
    const digest = securitySubjectDigest(this.#subjectDigestKey, event.identity);
    const authorizationSnapshot = normalized.authorizationSnapshot
      ? JSON.stringify(normalized.authorizationSnapshot)
      : null;

    const rows = await this.sql<ActionLogInsertRow[]>`
      insert into platform.action_logs (
        event_class,
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
        'security_rejection',
        null,
        null,
        null,
        null,
        null,
        ${normalized.adminId},
        'admin_web',
        null,
        null,
        'workforce_oidc',
        ${authorizationSnapshot}::jsonb,
        ${ADMIN_SECURITY_AUDIT_ACTION},
        ${ADMIN_SECURITY_AUDIT_TARGET_TYPE},
        ${normalized.permission},
        'deny',
        'denied',
        null,
        0,
        null,
        null,
        ${normalized.requestId},
        ${digest},
        null,
        null,
        ${normalized.reasonCode}
      )
      returning id::text as id
    `;

    if (rows.length !== 1 || !rows[0] || !UUID_PATTERN.test(rows[0].id)) {
      throw new Error("Admin security rejection audit was not persisted");
    }
  }
}
