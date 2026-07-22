import { createHmac } from "node:crypto";

import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import type { AdminSecurityRejection } from "./admin-request.js";
import {
  PostgresAdminAuthorizationRepository,
  PostgresAdminSecurityAudit,
} from "./admin-postgres.js";

const ids = {
  actionLog: "11111111-1111-4111-8111-111111111111",
  admin: "22222222-2222-4222-8222-222222222222",
} as const;

interface QueryCapture {
  text: string;
  values: unknown[];
}

function sqlHarness(rows: unknown[] = []): {
  calls: QueryCapture[];
  sql: PostgresClient;
} {
  const calls: QueryCapture[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(rows);
  }) as unknown as PostgresClient;
  return { calls, sql };
}

const inactiveRejection: AdminSecurityRejection = {
  adminId: null,
  authenticationAssurance: "workforce_oidc",
  authorizationSnapshot: null,
  channel: "admin_web",
  eventClass: "security_rejection",
  identity: {
    issuer: "https://workforce.example.test/oidc",
    subject: "workforce-user-42",
  },
  permission: "moderation:read",
  reasonCode: "admin_not_active",
  requestId: "req-admin-denied-01",
};

describe("PostgresAdminAuthorizationRepository", () => {
  it("resolves effective RBAC with one current, deny-by-default query", async () => {
    const { calls, sql } = sqlHarness([
      {
        admin_id: ids.admin,
        permissions: ["moderation:read", "audit:read", "moderation:read"],
        roles: ["content_moderator", "audit_reader", "content_moderator"],
      },
    ]);
    const repository = new PostgresAdminAuthorizationRepository(sql);

    await expect(
      repository.resolveActiveAuthorization({
        issuer: "https://workforce.example.test/oidc",
        subject: "workforce-user-42",
      }),
    ).resolves.toEqual({
      adminId: ids.admin,
      permissions: ["audit:read", "moderation:read"],
      roles: ["audit_reader", "content_moderator"],
    });

    expect(calls).toHaveLength(1);
    const query = calls[0]!;
    expect(query.text).toContain("admin.status = 'active'");
    expect(query.text).toContain("assignment.granted_at <= clock_timestamp()");
    expect(query.text).toContain("assignment.revoked_at is null");
    expect(query.text).toContain("assignment.expires_at > clock_timestamp()");
    expect(query.text).toContain("role.status = 'active'");
    expect(query.text).toContain("array_agg(distinct role.key order by role.key)");
    expect(query.text).toContain("count(distinct role_permission.permission) > 0");
    expect(query.values).toEqual([
      "https://workforce.example.test/oidc",
      "workforce-user-42",
    ]);
  });

  it("returns null for unknown, inactive, expired, revoked, or permissionless identities", async () => {
    const { calls, sql } = sqlHarness([]);
    const repository = new PostgresAdminAuthorizationRepository(sql);

    await expect(
      repository.resolveActiveAuthorization({ issuer: "https://idp.test", subject: "x" }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("fails closed on ambiguous or malformed database authorization", async () => {
    const ambiguous = sqlHarness([
      { admin_id: ids.admin, permissions: ["audit:read"], roles: ["audit_reader"] },
      { admin_id: ids.admin, permissions: ["audit:read"], roles: ["audit_reader"] },
    ]);
    await expect(
      new PostgresAdminAuthorizationRepository(ambiguous.sql).resolveActiveAuthorization({
        issuer: "https://idp.test",
        subject: "x",
      }),
    ).rejects.toThrow(/ambiguous/u);

    const malformed = sqlHarness([
      {
        admin_id: ids.admin,
        permissions: ["made-up:permission"],
        roles: ["audit_reader"],
      },
    ]);
    await expect(
      new PostgresAdminAuthorizationRepository(malformed.sql).resolveActiveAuthorization({
        issuer: "https://idp.test",
        subject: "x",
      }),
    ).rejects.toThrow(/invalid permissions/u);
  });

  it("rejects malformed OIDC identifiers before accessing PostgreSQL", async () => {
    const { calls, sql } = sqlHarness([]);
    const repository = new PostgresAdminAuthorizationRepository(sql);

    await expect(
      repository.resolveActiveAuthorization({
        issuer: "https://idp.test/unsafe issuer",
        subject: "x",
      }),
    ).rejects.toThrow(/issuer/u);
    await expect(
      repository.resolveActiveAuthorization({
        issuer: "https://idp.test",
        subject: "unsafe\0subject",
      }),
    ).rejects.toThrow(/subject/u);
    expect(calls).toHaveLength(0);
  });

  it("propagates database failures for the request boundary to fail closed", async () => {
    const sql = vi.fn(() => Promise.reject(new Error("database unavailable")));
    const repository = new PostgresAdminAuthorizationRepository(
      sql as unknown as PostgresClient,
    );

    await expect(
      repository.resolveActiveAuthorization({ issuer: "https://idp.test", subject: "x" }),
    ).rejects.toThrow("database unavailable");
  });
});

describe("PostgresAdminSecurityAudit", () => {
  it("persists a constraint-complete denial with only a keyed identity digest", async () => {
    const { calls, sql } = sqlHarness([{ id: ids.actionLog }]);
    const audit = new PostgresAdminSecurityAudit(sql, Buffer.alloc(32, 0x42));

    await expect(
      audit.recordSecurityRejection(inactiveRejection),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const query = calls[0]!;
    expect(query.text).toContain("insert into platform.action_logs");
    expect(query.text).toContain("'security_rejection'");
    expect(query.text).toContain("'admin_web'");
    expect(query.text).toContain("'workforce_oidc'");
    expect(query.text).toContain("'deny'");
    expect(query.text).toContain("'denied'");
    expect(query.text).toContain("security_subject_digest");
    expect(query.values).toContain("admin.request.authorize");
    expect(query.values).toContain("admin_permission");
    expect(query.values).toContain("moderation:read");
    expect(query.values).toContain("admin_not_active");

    const serializedQuery = JSON.stringify(query, (_key, value: unknown) =>
      Buffer.isBuffer(value) ? value.toString("hex") : value,
    );
    expect(serializedQuery).not.toContain(inactiveRejection.identity.issuer);
    expect(serializedQuery).not.toContain(inactiveRejection.identity.subject);
    const digest = query.values.find(
      (value): value is Buffer => Buffer.isBuffer(value) && value.byteLength === 32,
    );
    expect(digest).toBeDefined();
  });

  it("uses a versioned digest domain and length frames issuer/subject", async () => {
    const key = Buffer.alloc(32, 0x24);
    const first = sqlHarness([{ id: ids.actionLog }]);
    const second = sqlHarness([{ id: ids.actionLog }]);
    const firstAudit = new PostgresAdminSecurityAudit(first.sql, key);
    const secondAudit = new PostgresAdminSecurityAudit(second.sql, key);

    await firstAudit.recordSecurityRejection({
      ...inactiveRejection,
      identity: { issuer: "https://idp.test/a", subject: "bc" },
    });
    await secondAudit.recordSecurityRejection({
      ...inactiveRejection,
      identity: { issuer: "https://idp.test/ab", subject: "c" },
    });

    const firstDigest = first.calls[0]!.values.find((value) =>
      Buffer.isBuffer(value),
    ) as Buffer;
    const secondDigest = second.calls[0]!.values.find((value) =>
      Buffer.isBuffer(value),
    ) as Buffer;
    const undomained = createHmac("sha256", key)
      .update("https://idp.test/a", "utf8")
      .update("bc", "utf8")
      .digest();
    expect(firstDigest).not.toEqual(secondDigest);
    expect(firstDigest).not.toEqual(undomained);
  });

  it("stores a normalized, secret-free authorization snapshot for permission denial", async () => {
    const { calls, sql } = sqlHarness([{ id: ids.actionLog }]);
    const audit = new PostgresAdminSecurityAudit(sql, Buffer.alloc(32, 0x31));

    await audit.recordSecurityRejection({
      ...inactiveRejection,
      adminId: ids.admin,
      authorizationSnapshot: {
        permission: "moderation:decide",
        permissions: ["moderation:read", "audit:read", "moderation:read"],
        roles: ["content_moderator", "audit_reader", "content_moderator"],
      },
      permission: "moderation:decide",
      reasonCode: "admin_permission_required",
    });

    expect(calls[0]!.values).toContain(ids.admin);
    expect(calls[0]!.values).toContain(
      JSON.stringify({
        permission: "moderation:decide",
        permissions: ["audit:read", "moderation:read"],
        roles: ["audit_reader", "content_moderator"],
      }),
    );
  });

  it("validates the HMAC key and rejects inconsistent events before writing", async () => {
    const { calls, sql } = sqlHarness([{ id: ids.actionLog }]);
    expect(() => new PostgresAdminSecurityAudit(sql, Buffer.alloc(31))).toThrow(
      /32\+ bytes/u,
    );

    const audit = new PostgresAdminSecurityAudit(sql, Buffer.alloc(32));
    await expect(
      audit.recordSecurityRejection({
        ...inactiveRejection,
        adminId: ids.admin,
      }),
    ).rejects.toThrow(/must not claim Admin authority/u);
    expect(calls).toHaveLength(0);
  });

  it("propagates insert failures so authorization denies with dependency unavailable", async () => {
    const sql = vi.fn(() => Promise.reject(new Error("audit unavailable")));
    const audit = new PostgresAdminSecurityAudit(
      sql as unknown as PostgresClient,
      Buffer.alloc(32),
    );

    await expect(audit.recordSecurityRejection(inactiveRejection)).rejects.toThrow(
      "audit unavailable",
    );
  });

  it("fails closed if PostgreSQL does not confirm one durable audit row", async () => {
    const { sql } = sqlHarness([]);
    const audit = new PostgresAdminSecurityAudit(sql, Buffer.alloc(32));

    await expect(audit.recordSecurityRejection(inactiveRejection)).rejects.toThrow(
      /not persisted/u,
    );
  });
});
