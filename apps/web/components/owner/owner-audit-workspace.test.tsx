import {
  OwnerAuditActionListResponseSchema,
  OwnerAuditSearchListResponseSchema,
} from "@alphanet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OwnerAuditWorkspace } from "./owner-audit-workspace";

const ids = {
  action: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  agent: "33333333-3333-4333-8333-333333333333",
  credential: "44444444-4444-4444-8444-444444444444",
} as const;
const timestamp = "2026-07-23T08:00:00.000Z";
const tokenPrefix = ["aln", "v1", "prefix"].join("_");

function actionResponse() {
  return OwnerAuditActionListResponseSchema.parse({
    filters: {
      action: "content.create_post",
      agent_id: null,
      credential_id: null,
      from: null,
      outcome: "succeeded",
      to: null,
    },
    items: [
      {
        action: "content.create_post",
        actor: {
          display_name: "Alpha Research",
          handle: "alpha-research",
          id: ids.actor,
          kind: "agent",
        },
        agent: {
          display_name: "Alpha Research",
          handle: "alpha-research",
          id: ids.agent,
        },
        approval_method: "policy_auto",
        approved_by_owner: false,
        channel: "mcp",
        credential: {
          id: ids.credential,
          name: "Research runtime",
          token_prefix: tokenPrefix,
        },
        decision: "allow",
        error_code: null,
        event_class: "domain_write",
        id: ids.action,
        occurred_at: timestamp,
        outbox_event_id: null,
        outcome: "succeeded",
        policy_version: "4",
        reason_code: null,
        request_id: "req_action_01",
        retry_count: 0,
        target: { id: "target<script>", type: "content" },
      },
    ],
    page: {
      has_more: true,
      limit: 25,
      next_cursor: "signed-owner-audit-cursor",
    },
    request_id: "req_page_01",
    schema_version: "1",
  });
}

function searchResponse() {
  return OwnerAuditSearchListResponseSchema.parse({
    filters: {
      agent_id: null,
      credential_id: null,
      from: null,
      outcome: null,
      surface: null,
      to: null,
    },
    items: [
      {
        agent: {
          display_name: "Alpha Research",
          handle: "alpha-research",
          id: ids.agent,
        },
        credential: {
          id: ids.credential,
          name: "Research runtime",
          token_prefix: tokenPrefix,
        },
        expires_at: "2026-08-22T08:00:00.000Z",
        fallback_reason_code: null,
        finalized_at: "2026-07-23T08:00:00.100Z",
        id: ids.action,
        latency_ms: 100,
        occurred_at: timestamp,
        outcome: "succeeded",
        request_id: "req_search_01",
        result_count: 20,
        search_mode: "hybrid",
        surface: "mcp",
      },
    ],
    page: { has_more: false, limit: 25, next_cursor: null },
    request_id: "req_search_page",
    schema_version: "1",
  });
}

describe("Owner audit workspace", () => {
  it("renders all required action trace fields and preserves pagination filters", () => {
    const html = renderToStaticMarkup(
      <OwnerAuditWorkspace
        agents={[]}
        credentials={[]}
        response={actionResponse()}
        stream="actions"
        values={{ action: "content.create_post", outcome: "succeeded" }}
      />,
    );

    expect(html).toContain("content.create_post");
    expect(html).toContain("aln_v1_prefix");
    expect(html).toContain("Request ID");
    expect(html).toContain("policy_auto");
    expect(html).toContain("signed-owner-audit-cursor");
    expect(html).toContain("action=content.create_post");
    expect(html).not.toContain("target<script>");
    expect(html).toContain("target&lt;script&gt;");
  });

  it("renders search reservation/final state without a query field", () => {
    const html = renderToStaticMarkup(
      <OwnerAuditWorkspace
        agents={[]}
        credentials={[]}
        response={searchResponse()}
        stream="search"
        values={{}}
      />,
    );

    expect(html).toContain("MCP Search");
    expect(html).toContain("100 ms");
    expect(html).toContain("不保存原始 query");
    expect(html).not.toContain('name="query"');
    expect(html).not.toContain("query_hmac");
  });
});
