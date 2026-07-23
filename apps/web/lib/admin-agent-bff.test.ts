import { describe, expect, it } from "vitest";

import {
  parseAdminAgentActionBffRequest,
  parseAdminAgentPath,
  readAdminAgentBffJson,
} from "./admin-agent-bff";
import { parseAdminAgentQuery } from "./admin-agent-query";

const attemptId = "40000000-0000-4000-8000-000000000001";
const agentId = "40000000-0000-4000-8000-000000000002";

describe("Admin Agent browser boundary", () => {
  it("accepts only strict action bodies with browser-generated attempts", () => {
    expect(
      parseAdminAgentActionBffRequest({
        action: {
          action: "suspend_agent",
          reason_code: "platform_policy_violation",
        },
        agent_version: 3,
        attempt_id: attemptId,
      }),
    ).toEqual({
      action: {
        action: "suspend_agent",
        reason_code: "platform_policy_violation",
      },
      agentVersion: 3,
      attemptId,
    });
    expect(
      parseAdminAgentActionBffRequest({
        action: {
          action: "suspend_agent",
          reason_code: "risk_condition_resolved",
        },
        agent_version: 3,
        attempt_id: attemptId,
      }),
    ).toBeNull();
    expect(
      parseAdminAgentActionBffRequest({
        action: {
          action: "suspend_agent",
          reason_code: "platform_policy_violation",
        },
        agent_version: 3,
        attempt_id: attemptId,
        idempotency_key: "browser-controlled",
      }),
    ).toBeNull();
    expect(parseAdminAgentPath(agentId)).toBe(agentId);
    expect(parseAdminAgentPath("not-an-id")).toBeNull();
  });

  it("bounds JSON input and rejects non-JSON requests", async () => {
    const valid = new Request(
      `https://app.alphanet.test/admin/agents/${agentId}/actions`,
      {
        body: JSON.stringify({ attempt_id: attemptId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    await expect(readAdminAgentBffJson(valid)).resolves.toEqual({
      attempt_id: attemptId,
    });
    const invalid = new Request(
      `https://app.alphanet.test/admin/agents/${agentId}/actions`,
      {
        body: "{}",
        headers: { "content-type": "text/plain" },
        method: "POST",
      },
    );
    await expect(readAdminAgentBffJson(invalid)).resolves.toBeNull();
  });

  it("parses only canonical Agent list filters", () => {
    expect(
      parseAdminAgentQuery({
        limit: "25",
        query: "semi",
        statuses: "active,restricted",
      }),
    ).toEqual({
      ok: true,
      value: {
        limit: 25,
        query: "semi",
        statuses: ["active", "restricted"],
      },
    });
    expect(parseAdminAgentQuery({ statuses: ["active", "suspended"] })).toEqual({
      ok: false,
    });
    expect(parseAdminAgentQuery({ statuses: "active,active" })).toEqual({
      ok: false,
    });
    expect(parseAdminAgentQuery({ unexpected: "true" })).toEqual({ ok: false });
  });
});
