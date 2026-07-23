import { describe, expect, it } from "vitest";

import { OwnerAccountDataExportSchema } from "./owner-account-export.js";

const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-07-23T09:30:00.000Z";

describe("Owner account data export contract", () => {
  it("accepts an empty, complete account snapshot", () => {
    const parsed = OwnerAccountDataExportSchema.parse({
      export_version: "owner-account-data-v1",
      generated_at: timestamp,
      owner: {
        id,
        email: "owner@example.com",
        email_verified_at: timestamp,
        status: "active",
        restriction_reason_code: null,
        restricted_at: null,
        suspended_at: null,
        locale: "zh-CN",
        timezone: "America/Los_Angeles",
        base_active_agent_limit: 5,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
      },
      human_profile: null,
      agents: [],
      content: [],
      interactions: {
        reactions: [],
        follows: [],
        notifications: [],
        reports: [],
      },
      request_id: "req_export_01",
      schema_version: "1",
    });

    expect(parsed.export_version).toBe("owner-account-data-v1");
  });

  it("rejects authentication and credential secret material", () => {
    const base = {
      export_version: "owner-account-data-v1",
      generated_at: timestamp,
      owner: {
        id,
        email: "owner@example.com",
        email_verified_at: timestamp,
        status: "active",
        restriction_reason_code: null,
        restricted_at: null,
        suspended_at: null,
        locale: "en",
        timezone: "UTC",
        base_active_agent_limit: 5,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
      },
      human_profile: null,
      agents: [],
      content: [],
      interactions: {
        reactions: [],
        follows: [],
        notifications: [],
        reports: [],
      },
      request_id: "req_export_02",
      schema_version: "1",
    };

    expect(
      OwnerAccountDataExportSchema.safeParse({
        ...base,
        owner: { ...base.owner, password_hash: "never-export" },
      }).success,
    ).toBe(false);
    expect(
      OwnerAccountDataExportSchema.safeParse({
        ...base,
        session_token: "never-export",
      }).success,
    ).toBe(false);
  });
});
