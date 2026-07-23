import { describe, expect, it } from "vitest";

import {
  AdminAgentActionHeadersSchema,
  AdminAgentActionRequestSchema,
  AdminAgentListRequestSchema,
  AdminAgentListResponseSchema,
} from "./admin-agent-enforcement.ts";

describe("Admin Agent enforcement contracts", () => {
  it("binds every action to its controlled reason taxonomy", () => {
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "suspend_agent",
        reason_code: "coordinated_manipulation",
      }).success,
    ).toBe(true);
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "restore_agent",
        reason_code: "risk_condition_resolved",
      }).success,
    ).toBe(true);
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "revoke_credentials",
        reason_code: "credential_compromise",
      }).success,
    ).toBe(true);
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "restore_agent",
        reason_code: "spam_automation",
      }).success,
    ).toBe(false);
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "revoke_credentials",
        reason_code: "coordinated_manipulation",
      }).success,
    ).toBe(false);
  });

  it("rejects transport authority inside the body and duplicate transport headers", () => {
    expect(
      AdminAgentActionRequestSchema.safeParse({
        action: "suspend_agent",
        agent_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf6",
        expected_version: 1,
        idempotency_key: "forged",
        reason_code: "security_incident",
      }).success,
    ).toBe(false);
    expect(
      AdminAgentActionHeadersSchema.safeParse({
        "idempotency-key": "one,two",
        "if-match": '"1"',
      }).success,
    ).toBe(false);
    expect(
      AdminAgentActionHeadersSchema.safeParse({
        "idempotency-key": "agent-action-1",
        "if-match": 'W/"1"',
      }).success,
    ).toBe(false);
  });

  it("keeps list filters strict and unique", () => {
    expect(
      AdminAgentListRequestSchema.safeParse({
        statuses: ["active", "suspended"],
        query: "alpha",
        limit: 25,
      }).success,
    ).toBe(true);
    expect(
      AdminAgentListRequestSchema.safeParse({
        statuses: ["active", "active"],
      }).success,
    ).toBe(false);
    expect(
      AdminAgentListRequestSchema.safeParse({
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("rejects secret-shaped or inconsistent Agent list projections", () => {
    const valid = {
      capabilities: {
        can_restrict: true,
        can_revoke_credentials: true,
      },
      items: [
        {
          agent_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf6",
          actor_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf7",
          owner_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf8",
          handle: "alpha-agent",
          display_name: "Alpha Agent",
          discovery_tags: ["semiconductors"],
          status: "active",
          restriction_reason_code: null,
          governance_version: 1,
          credential_counts: {
            active: 1,
            expired: 0,
            revoked: 1,
            total: 2,
          },
          created_at: "2026-07-23T12:00:00.000Z",
          updated_at: "2026-07-23T12:00:00.000Z",
          activated_at: "2026-07-23T12:00:00.000Z",
          restricted_at: null,
          suspended_at: null,
          archived_at: null,
        },
      ],
      ordering: {
        as_of: "2026-07-23T12:00:00.000Z",
        ordering_version: "admin-agent-created-keyset-v1",
        snapshot_id: "agent-snapshot",
      },
      page: {
        has_more: false,
        limit: 25,
        next_cursor: null,
      },
      request_id: "request-1",
      schema_version: "1",
    };
    expect(AdminAgentListResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      AdminAgentListResponseSchema.safeParse({
        ...valid,
        items: [
          {
            ...valid.items[0],
            credential_counts: {
              active: 2,
              expired: 0,
              revoked: 1,
              total: 2,
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AdminAgentListResponseSchema.safeParse({
        ...valid,
        items: [{ ...valid.items[0], api_key: "secret" }],
      }).success,
    ).toBe(false);
  });
});
