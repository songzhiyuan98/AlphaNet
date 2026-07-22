import { describe, expect, it } from "vitest";

import {
  parseAdminModerationBffRequest,
  readAdminModerationBffRequest,
} from "./admin-moderation-bff";

const attemptId = "10000000-0000-4000-8000-000000000001";

describe("Admin moderation BFF request", () => {
  it("accepts only the browser decision, current Case version, and attempt UUID", () => {
    expect(
      parseAdminModerationBffRequest({
        attempt_id: attemptId,
        case_version: 7,
        decision: {
          action: "hide_content",
          internal_note: "Verified against the policy evidence.",
          reason_code: "confirmed_report_violation",
        },
      }),
    ).toEqual({
      attemptId,
      caseVersion: 7,
      decision: {
        action: "hide_content",
        internal_note: "Verified against the policy evidence.",
        reason_code: "confirmed_report_violation",
      },
    });
  });

  it("rejects forged transport fields, unknown keys, invalid versions, and invalid UUIDs", () => {
    const valid = {
      attempt_id: attemptId,
      case_version: 7,
      decision: {
        action: "dismiss",
        reason_code: "no_rule_violation",
      },
    };
    for (const value of [
      null,
      [],
      { ...valid, if_match: '"999"' },
      { ...valid, idempotency_key: "attacker-key" },
      { ...valid, case_version: 0 },
      { ...valid, case_version: 1.5 },
      { ...valid, attempt_id: "not-a-uuid" },
      {
        ...valid,
        decision: { action: "hide_content", reason_code: "no_rule_violation" },
      },
    ]) {
      expect(parseAdminModerationBffRequest(value)).toBeNull();
    }
  });

  it("reads only a bounded JSON request body", async () => {
    const body = {
      attempt_id: attemptId,
      case_version: 7,
      decision: { action: "dismiss", reason_code: "no_rule_violation" },
    };
    await expect(
      readAdminModerationBffRequest(
        new Request("https://app.alphanet.test/admin/moderation/case/actions", {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
    ).resolves.toEqual({
      attemptId,
      caseVersion: 7,
      decision: body.decision,
    });

    await expect(
      readAdminModerationBffRequest(
        new Request("https://app.alphanet.test/admin/moderation/case/actions", {
          body: JSON.stringify(body),
          headers: { "content-type": "text/plain" },
          method: "POST",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      readAdminModerationBffRequest(
        new Request("https://app.alphanet.test/admin/moderation/case/actions", {
          body: JSON.stringify({ ...body, padding: "x".repeat(20_000) }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
    ).resolves.toBeNull();
  });
});
