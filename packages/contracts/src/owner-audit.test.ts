import { describe, expect, it } from "vitest";

import {
  OwnerAuditActionListRequestSchema,
  OwnerAuditActionListResponseSchema,
  OwnerAuditSearchListResponseSchema,
} from "./owner-audit.js";

const ids = {
  action: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  agent: "33333333-3333-4333-8333-333333333333",
  credential: "44444444-4444-4444-8444-444444444444",
  outbox: "55555555-5555-4555-8555-555555555555",
} as const;
const occurredAt = "2026-07-23T08:00:00.000Z";

describe("Owner audit contracts", () => {
  it("accepts a bounded, secret-free action audit page", () => {
    const parsed = OwnerAuditActionListResponseSchema.parse({
      items: [
        {
          id: ids.action,
          event_class: "domain_write",
          occurred_at: occurredAt,
          actor: {
            id: ids.actor,
            kind: "agent",
            handle: "alpha-research",
            display_name: "Alpha Research",
          },
          agent: {
            id: ids.agent,
            handle: "alpha-research",
            display_name: "Alpha Research",
          },
          credential: {
            id: ids.credential,
            name: "Research runtime",
            token_prefix: "aln_v1_000000000001",
          },
          channel: "mcp",
          action: "content.create_post",
          target: { type: "content", id: ids.action },
          decision: "allow",
          outcome: "succeeded",
          error_code: null,
          reason_code: null,
          policy_version: "4",
          approval_method: "policy_auto",
          approved_by_owner: false,
          request_id: "req_owner_audit_01",
          outbox_event_id: ids.outbox,
          retry_count: 0,
        },
      ],
      page: { limit: 25, has_more: false, next_cursor: null },
      filters: {
        agent_id: ids.agent,
        credential_id: null,
        action: null,
        outcome: "succeeded",
        from: null,
        to: null,
      },
      request_id: "req_owner_audit_page",
      schema_version: "1",
    });
    expect(parsed.items[0]?.credential?.token_prefix).toBe("aln_v1_000000000001");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("keeps search activity metadata free of query text and query digests", () => {
    const parsed = OwnerAuditSearchListResponseSchema.parse({
      items: [
        {
          id: ids.action,
          occurred_at: occurredAt,
          finalized_at: "2026-07-23T08:00:00.100Z",
          expires_at: "2026-08-22T08:00:00.000Z",
          request_id: "req_search_01",
          agent: {
            id: ids.agent,
            handle: "alpha-research",
            display_name: "Alpha Research",
          },
          credential: {
            id: ids.credential,
            name: "Research runtime",
            token_prefix: "aln_v1_000000000001",
          },
          surface: "mcp",
          search_mode: "hybrid",
          outcome: "succeeded",
          result_count: 20,
          latency_ms: 184,
          fallback_reason_code: null,
        },
      ],
      page: { limit: 25, has_more: false, next_cursor: null },
      filters: {
        agent_id: null,
        credential_id: null,
        outcome: null,
        surface: null,
        from: null,
        to: null,
      },
      request_id: "req_owner_search_page",
      schema_version: "1",
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("query");
    expect(serialized).not.toContain("hmac");
  });

  it("rejects reversed time ranges and unknown query fields", () => {
    expect(
      OwnerAuditActionListRequestSchema.safeParse({
        from: "2026-07-24T00:00:00.000Z",
        to: "2026-07-23T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      OwnerAuditActionListRequestSchema.safeParse({ owner_id: ids.actor }).success,
    ).toBe(false);
  });
});
