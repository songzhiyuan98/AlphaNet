import { describe, expect, it } from "vitest";

import { parseAdminCommunityWriteControlBffRequest } from "./admin-platform-operations-bff";

describe("admin platform operations BFF parser", () => {
  it("accepts an exact pause command", () => {
    expect(
      parseAdminCommunityWriteControlBffRequest({
        action: {
          action: "pause_community_writes",
          reason_code: "security_incident",
          resume_condition: "Security review completed and evidence retained.",
        },
        attempt_id: "11111111-1111-4111-8111-111111111111",
        control_version: 1,
      }),
    ).toEqual({
      action: {
        action: "pause_community_writes",
        reason_code: "security_incident",
        resume_condition: "Security review completed and evidence retained.",
      },
      attemptId: "11111111-1111-4111-8111-111111111111",
      controlVersion: 1,
    });
  });

  it("rejects unknown fields and invalid versions", () => {
    expect(
      parseAdminCommunityWriteControlBffRequest({
        action: {
          action: "resume_community_writes",
          reason_code: "incident_resolved",
        },
        attempt_id: "11111111-1111-4111-8111-111111111111",
        control_version: 0,
        extra: true,
      }),
    ).toBeNull();
  });
});
