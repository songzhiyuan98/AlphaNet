import { describe, expect, it } from "vitest";

import {
  AdminCapacityActionHeadersSchema,
  AdminOwnerListRequestSchema,
  AdminOwnerListResponseSchema,
  AdminOwnerQuotaActionRequestSchema,
  AdminRegistrationControlActionRequestSchema,
  AdminRegistrationControlProjectionSchema,
} from "./admin-owner-capacity.ts";

describe("Admin Owner capacity contracts", () => {
  it("keeps quota commands strict, temporary and independent of Agent type", () => {
    expect(
      AdminOwnerQuotaActionRequestSchema.safeParse({
        action: "set_override",
        max_active_agents: 12,
        reason_code: "research_team_expansion",
        expires_at: "2026-08-01T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      AdminOwnerQuotaActionRequestSchema.safeParse({
        action: "set_override",
        max_active_agents: 12,
        reason_code: "automated_trading_agent",
        expires_at: "2026-08-01T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      AdminOwnerQuotaActionRequestSchema.safeParse({
        action: "revoke_override",
        reason_code: "security_incident",
        owner_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf6",
      }).success,
    ).toBe(false);
  });

  it("validates registration transitions and the 10,000-Agent ceiling", () => {
    expect(
      AdminRegistrationControlActionRequestSchema.safeParse({
        action: "pause_registration",
        reason_code: "capacity_threshold_reached",
        resume_condition:
          "Resume after capacity is confirmed below the operating target.",
      }).success,
    ).toBe(true);
    expect(
      AdminRegistrationControlActionRequestSchema.safeParse({
        action: "pause_registration",
        reason_code: "capacity_threshold_reached",
      }).success,
    ).toBe(false);
    expect(
      AdminRegistrationControlActionRequestSchema.safeParse({
        action: "set_capacity_limits",
        reason_code: "validated_operational_need",
        active_agent_operating_target: 9_000,
        active_agent_hard_limit: 8_000,
      }).success,
    ).toBe(false);
    expect(
      AdminRegistrationControlActionRequestSchema.safeParse({
        action: "set_capacity_limits",
        reason_code: "validated_operational_need",
        active_agent_operating_target: 10_000,
        active_agent_hard_limit: 10_001,
      }).success,
    ).toBe(false);
  });

  it("rejects weak versions and authority smuggled through action headers", () => {
    expect(
      AdminCapacityActionHeadersSchema.safeParse({
        "idempotency-key": "capacity-action-0001",
        "if-match": '"4"',
      }).success,
    ).toBe(true);
    expect(
      AdminCapacityActionHeadersSchema.safeParse({
        "idempotency-key": "capacity-action-0001",
        "if-match": 'W/"4"',
      }).success,
    ).toBe(false);
    expect(
      AdminCapacityActionHeadersSchema.safeParse({
        "idempotency-key": "one,two",
        "if-match": '"4"',
      }).success,
    ).toBe(false);
  });

  it("keeps list filters and Owner projections bounded and secret-free", () => {
    expect(
      AdminOwnerListRequestSchema.safeParse({
        statuses: ["active", "suspended"],
        query: "owner@example.com",
        limit: 25,
      }).success,
    ).toBe(true);
    expect(
      AdminOwnerListRequestSchema.safeParse({
        statuses: ["active", "active"],
      }).success,
    ).toBe(false);

    const valid = {
      capabilities: { can_manage_quota: true },
      items: [
        {
          owner_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf6",
          email_hint: "o***r@example.com",
          status: "active",
          email_verified: true,
          quota_version: 2,
          base_active_agent_limit: 5,
          effective_active_agent_limit: 10,
          active_agent_count: 4,
          total_agent_count: 6,
          credential_counts: { active: 2, expired: 1, revoked: 1, total: 4 },
          current_override: {
            override_id: "018f5d4e-7b58-7b30-8c0c-2fd221b6cbf7",
            max_active_agents: 10,
            reason_code: "validated_operational_need",
            created_at: "2026-07-23T12:00:00.000Z",
            expires_at: "2026-08-01T12:00:00.000Z",
          },
          created_at: "2026-07-20T12:00:00.000Z",
          updated_at: "2026-07-23T12:00:00.000Z",
          restricted_at: null,
          suspended_at: null,
          closed_at: null,
        },
      ],
      ordering: {
        as_of: "2026-07-23T12:00:00.000Z",
        ordering_version: "admin-owner-created-keyset-v1",
        snapshot_id: "owner-snapshot",
      },
      page: { has_more: false, limit: 25, next_cursor: null },
      request_id: "request-1",
      schema_version: "1",
    };
    expect(AdminOwnerListResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      AdminOwnerListResponseSchema.safeParse({
        ...valid,
        items: [{ ...valid.items[0], password_hash: "secret" }],
      }).success,
    ).toBe(false);
  });

  it("requires registration metadata to agree with the mode and capacity", () => {
    expect(
      AdminRegistrationControlProjectionSchema.safeParse({
        mode: "paused",
        version: 3,
        pause_reason_code: "security_incident",
        paused_at: "2026-07-23T12:00:00.000Z",
        resume_condition: "Resume after incident containment.",
        active_agent_count: 4_000,
        active_agent_operating_target: 5_000,
        active_agent_hard_limit: 10_000,
        updated_at: "2026-07-23T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      AdminRegistrationControlProjectionSchema.safeParse({
        mode: "open",
        version: 4,
        pause_reason_code: null,
        paused_at: null,
        resume_condition: null,
        active_agent_count: 6_000,
        active_agent_operating_target: 5_000,
        active_agent_hard_limit: 10_000,
        updated_at: "2026-07-23T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      AdminRegistrationControlProjectionSchema.safeParse({
        mode: "open",
        version: 3,
        pause_reason_code: "security_incident",
        paused_at: "2026-07-23T12:00:00.000Z",
        resume_condition: null,
        active_agent_count: 4_000,
        active_agent_operating_target: 5_000,
        active_agent_hard_limit: 10_000,
        updated_at: "2026-07-23T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
