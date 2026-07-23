import { describe, expect, it } from "vitest";

import { ownerAuditHref, parseOwnerAuditPageQuery } from "./owner-audit-query";

const agentId = "20000000-0000-4000-8000-000000000001";
const credentialId = "30000000-0000-4000-8000-000000000001";

describe("Owner audit page query", () => {
  it("normalizes UTC form timestamps and ignores empty optional controls", () => {
    const parsed = parseOwnerAuditPageQuery({
      action: "content.create_post",
      agent_id: agentId,
      credential_id: "",
      from: "2026-07-23T08:15",
      limit: "25",
      outcome: "succeeded",
      stream: "actions",
      to: "",
    });

    expect(parsed).toMatchObject({
      actionFilters: {
        action: "content.create_post",
        agent_id: agentId,
        from: "2026-07-23T08:15:00.000Z",
        limit: 25,
        outcome: "succeeded",
      },
      ok: true,
      stream: "actions",
    });
  });

  it("parses search-only filters without accepting action fields", () => {
    expect(
      parseOwnerAuditPageQuery({
        agent_id: agentId,
        outcome: "started",
        stream: "search",
        surface: "mcp",
      }),
    ).toMatchObject({
      ok: true,
      searchFilters: {
        agent_id: agentId,
        outcome: "started",
        surface: "mcp",
      },
      stream: "search",
    });
    expect(
      parseOwnerAuditPageQuery({
        action: "content.create_post",
        stream: "search",
      }),
    ).toEqual({ ok: false });
  });

  it.each([
    { stream: ["actions", "search"] },
    { owner_id: "forged", stream: "actions" },
    { from: "2026-02-30T12:00", stream: "actions" },
    { limit: "01", stream: "actions" },
    { agent_id: "not an opaque id", stream: "actions" },
    { outcome: "allowed", stream: "actions" },
  ])("fails closed for invalid or ambiguous values: %o", (query) => {
    expect(parseOwnerAuditPageQuery(query)).toEqual({ ok: false });
  });

  it("preserves filters in an opaque forward cursor link", () => {
    const href = ownerAuditHref(
      "actions",
      {
        agent_id: agentId,
        credential_id: credentialId,
        from: "2026-07-23T08:15",
        limit: "50",
        outcome: "denied",
      },
      "signed.cursor/value",
    );
    const url = new URL(href, "https://alphanet.example");

    expect(url.pathname).toBe("/settings/activity");
    expect(url.searchParams.get("stream")).toBe("actions");
    expect(url.searchParams.get("credential_id")).toBe(credentialId);
    expect(url.searchParams.get("cursor")).toBe("signed.cursor/value");
  });
});
