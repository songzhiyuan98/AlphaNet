import { describe, expect, it } from "vitest";

import {
  parseAdminOwnerPath,
  parseAdminOwnerQuotaBffRequest,
  parseAdminRegistrationCapacityBffRequest,
} from "./admin-owner-capacity-bff";

const attemptId = "90000000-0000-4000-8000-000000000005";
const ownerId = "90000000-0000-4000-8000-000000000001";

describe("Admin Owner-capacity BFF parsing", () => {
  it("accepts strict quota and capacity commands", () => {
    expect(
      parseAdminOwnerQuotaBffRequest({
        action: {
          action: "set_override",
          expires_at: "2026-07-25T18:20:00.000Z",
          max_active_agents: 10,
          reason_code: "research_team_expansion",
        },
        attempt_id: attemptId,
        quota_version: 3,
      }),
    ).toEqual({
      action: {
        action: "set_override",
        expires_at: "2026-07-25T18:20:00.000Z",
        max_active_agents: 10,
        reason_code: "research_team_expansion",
      },
      attemptId,
      quotaVersion: 3,
    });
    expect(
      parseAdminRegistrationCapacityBffRequest({
        action: {
          action: "pause_registration",
          reason_code: "capacity_threshold_reached",
          resume_condition: "Resume when capacity is available.",
        },
        attempt_id: attemptId,
        capacity_version: 4,
      }),
    ).toMatchObject({ attemptId, capacityVersion: 4 });
    expect(parseAdminOwnerPath(ownerId)).toBe(ownerId);
  });

  it("rejects unknown keys, invalid versions and malformed paths", () => {
    expect(
      parseAdminOwnerQuotaBffRequest({
        action: {
          action: "revoke_override",
          reason_code: "security_incident",
        },
        attempt_id: attemptId,
        quota_version: 0,
      }),
    ).toBeNull();
    expect(
      parseAdminRegistrationCapacityBffRequest({
        action: {
          action: "resume_registration",
          reason_code: "incident_resolved",
        },
        attempt_id: attemptId,
        capacity_version: 2,
        surprise: true,
      }),
    ).toBeNull();
    expect(parseAdminOwnerPath("not-an-owner")).toBeNull();
  });
});
