import { describe, expect, it } from "vitest";

import {
  AdminCommunityWriteControlActionRequestSchema,
  AdminCommunityWriteControlActionResponseSchema,
  AdminCommunityWriteControlResponseSchema,
  AdminPlatformActionHeadersSchema,
} from "./admin-platform-operations.js";

const control = {
  mode: "paused",
  pause_reason_code: "security_incident",
  paused_at: "2026-07-23T20:00:00.000Z",
  resume_condition: "Resume after containment controls are verified.",
  updated_at: "2026-07-23T20:00:00.000Z",
  updated_by_admin_id: "41000000-0000-4000-8000-000000000001",
  version: 2,
} as const;

describe("Admin platform-operation contracts", () => {
  it("accepts controlled pause and resume commands with strong headers", () => {
    expect(
      AdminPlatformActionHeadersSchema.parse({
        "idempotency-key": "pause-community-writes-0001",
        "if-match": '"1"',
      }),
    ).toBeDefined();
    expect(
      AdminCommunityWriteControlActionRequestSchema.parse({
        action: "pause_community_writes",
        reason_code: "security_incident",
        resume_condition: "Resume after containment controls are verified.",
      }),
    ).toBeDefined();
    expect(
      AdminCommunityWriteControlActionRequestSchema.parse({
        action: "resume_community_writes",
        reason_code: "incident_resolved",
      }),
    ).toBeDefined();
  });

  it("rejects ambiguous state, reasons, and optimistic-concurrency headers", () => {
    expect(
      AdminPlatformActionHeadersSchema.safeParse({
        "idempotency-key": "pause-community-writes-0001",
        "if-match": "1",
      }).success,
    ).toBe(false);
    expect(
      AdminCommunityWriteControlActionRequestSchema.safeParse({
        action: "pause_community_writes",
        reason_code: "anything",
        resume_condition: "Resume.",
      }).success,
    ).toBe(false);
    expect(
      AdminCommunityWriteControlResponseSchema.safeParse({
        capabilities: { can_operate_platform: true },
        control: { ...control, mode: "open" },
        request_id: "request-1",
        schema_version: "1",
      }).success,
    ).toBe(false);
  });

  it("validates one-version action advancement", () => {
    const response = {
      action: {
        action: "pause_community_writes",
        action_id: "41000000-0000-4000-8000-000000000002",
        admin_id: "41000000-0000-4000-8000-000000000001",
        occurred_at: "2026-07-23T20:00:00.000Z",
        permission_used: "platform:operate",
        reason_code: "security_incident",
        version_after: 2,
        version_before: 1,
      },
      control,
      request_id: "request-2",
      schema_version: "1",
    };
    expect(AdminCommunityWriteControlActionResponseSchema.parse(response)).toBeDefined();
    expect(
      AdminCommunityWriteControlActionResponseSchema.safeParse({
        ...response,
        action: { ...response.action, version_after: 3 },
      }).success,
    ).toBe(false);
  });
});
