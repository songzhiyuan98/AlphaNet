import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReleaseReport,
  evidenceFileName,
  validateGateEvidence,
} from "./check-mvp-release.mjs";

const releaseSha = "a".repeat(40);
const observedAt = new Date().toISOString();
const manifest = {
  source_acceptance_count: 1,
  global_release_gates: [
    { id: "product_spec_alignment", class: "repository" },
    { id: "search_degradation", class: "release_candidate" },
  ],
};
const acceptanceReport = {
  source_acceptance_count: 1,
  counts: { approved_difference: 0 },
  requirements: [
    {
      id: "AC-SR-07",
      release_gates: ["search_degradation"],
    },
  ],
};
const searchEvidence = {
  schema_version: "1",
  gate: "search_degradation",
  release_sha: releaseSha,
  result: "pass",
  observed_at: observedAt,
  query_fingerprint: { result_count: 2 },
  checks: {
    lexical_usable: true,
    hybrid_degraded_to_lexical: true,
    degraded_results_equal_lexical_results: true,
    semantic_failure_explicit: true,
  },
  contains_credentials_or_content: false,
};

test("uses stable evidence file names", () => {
  assert.equal(evidenceFileName("notification_slo"), "notification-slo.json");
});

test("returns GO only when every global and mapped acceptance gate passes", () => {
  const report = buildReleaseReport({
    acceptanceReport,
    evidenceByGate: new Map([["search_degradation", searchEvidence]]),
    manifest,
    releaseSha,
  });
  assert.equal(report.decision, "GO");
  assert.deepEqual(report.summary, {
    pass: 2,
    missing: 0,
    invalid: 0,
    blocked_requirements: 0,
  });
});

test("fails closed when exact-SHA evidence is missing or stale", () => {
  const missing = buildReleaseReport({
    acceptanceReport,
    evidenceByGate: new Map(),
    manifest,
    releaseSha,
  });
  assert.equal(missing.decision, "NO_GO");
  assert.equal(missing.summary.missing, 1);
  assert.equal(missing.summary.blocked_requirements, 1);

  const stale = buildReleaseReport({
    acceptanceReport,
    evidenceByGate: new Map([
      ["search_degradation", { ...searchEvidence, release_sha: "b".repeat(40) }],
    ]),
    manifest,
    releaseSha,
  });
  assert.equal(stale.decision, "NO_GO");
  assert.match(stale.gates[1].error, /release_sha must match/u);
});

test("rejects notification evidence that weakens the agreed SLO", () => {
  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          schema_version: "1",
          gate: "notification_slo",
          release_sha: releaseSha,
          result: "pass",
          observed_at: observedAt,
          sample_count: 99,
          threshold_ms: 60_000,
          readable_within_threshold_rate: 1,
          latency_ms: { p99: 1 },
          contains_credentials_or_content: false,
        },
        gate: { id: "notification_slo" },
        releaseSha,
      }),
    /at least 100 samples/u,
  );
});

test("rejects an operations gate without an accountable incident drill", () => {
  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          schema_version: "1",
          gate: "operations_readiness",
          release_sha: releaseSha,
          result: "pass",
          observed_at: observedAt,
          status_url: "https://status.alphanet.example",
          security_contact: "security@alphanet.example",
          on_call_owner: "Primary operator",
          incident_drill: {
            result: "pass",
          },
          contains_credentials_or_content: false,
        },
        gate: { id: "operations_readiness" },
        releaseSha,
      }),
    /incident drill scenario is required/u,
  );
});

test("accepts an accountable, time-bounded operations drill", () => {
  assert.doesNotThrow(() =>
    validateGateEvidence({
      evidence: {
        schema_version: "1",
        gate: "operations_readiness",
        release_sha: releaseSha,
        result: "pass",
        observed_at: observedAt,
        status_url: "https://status.alphanet.example",
        security_contact: "security@alphanet.example",
        on_call_owner: "Primary operator",
        incident_drill: {
          result: "pass",
          scenario: "platform_write_containment",
          commander: "Incident commander",
          reviewer: "Independent reviewer",
          started_at: new Date(Date.now() - 30 * 60 * 1_000).toISOString(),
          ended_at: new Date(Date.now() - 15 * 60 * 1_000).toISOString(),
          checks: {
            detection: true,
            triage: true,
            containment: true,
            stakeholder_update: true,
            recovery: true,
            follow_up_ownership: true,
          },
        },
        contains_credentials_or_content: false,
      },
      gate: { id: "operations_readiness" },
      releaseSha,
    }),
  );
});

function productValueTask(index, scenario) {
  return {
    task_id: `task-${index}`,
    participant_key: `participant-${index % 5}`,
    participant_type: "non_developer",
    result: "pass",
    scenario,
    community_research_used: true,
    independent_verification_completed: true,
    materially_useful: true,
    outcome: "hypothesis_changed",
  };
}

test("requires diverse, independently verified product-value evidence", () => {
  const scenarios = [
    "blind_spot_discovery",
    "counter_thesis",
    "publish_and_discuss",
    "research_follow_up",
    "source_or_claim_validation",
  ];
  const tasks = Array.from({ length: 10 }, (_, index) =>
    productValueTask(index, scenarios[index % scenarios.length]),
  );

  assert.doesNotThrow(() =>
    validateGateEvidence({
      evidence: {
        schema_version: "1",
        gate: "product_value",
        release_sha: releaseSha,
        result: "pass",
        observed_at: observedAt,
        tasks,
        contains_credentials_or_content: false,
      },
      gate: { id: "product_value" },
      releaseSha,
    }),
  );

  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          schema_version: "1",
          gate: "product_value",
          release_sha: releaseSha,
          result: "pass",
          observed_at: observedAt,
          tasks: tasks.map((task) => ({
            ...task,
            scenario: "blind_spot_discovery",
          })),
          contains_credentials_or_content: false,
        },
        gate: { id: "product_value" },
        releaseSha,
      }),
    /missing scenario counter_thesis/u,
  );
});

const mcpToolNames = [
  "browse_content",
  "create_post",
  "delete_content",
  "find_communities",
  "get_action_status",
  "get_agent_context",
  "get_community",
  "get_content",
  "get_discussion",
  "list_follows",
  "list_notifications",
  "reply_to_content",
  "search_content",
  "set_follow",
  "set_reaction",
  "update_content",
];

function mcpHost(name) {
  return {
    name,
    version: "1.0.0",
    platform: "test-platform",
    protocol_version: "2025-06-18",
    transport: "streamable_http",
    authorization: "oauth_2_1_pkce",
    result: "pass",
    checks: {
      authorization_challenge: true,
      owner_login: true,
      agent_selection: true,
      tool_discovery: true,
      structured_results: true,
    },
    tools: mcpToolNames.map((toolName) => ({ name: toolName, result: "pass" })),
  };
}

test("requires three named Hosts to run the exact MCP tool suite", () => {
  const evidence = {
    schema_version: "1",
    gate: "mcp_host_interoperability",
    release_sha: releaseSha,
    result: "pass",
    observed_at: observedAt,
    hosts: [mcpHost("host-a"), mcpHost("host-b"), mcpHost("host-c")],
    contains_credentials_or_content: false,
  };

  assert.doesNotThrow(() =>
    validateGateEvidence({
      evidence,
      gate: { id: "mcp_host_interoperability" },
      releaseSha,
    }),
  );

  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          ...evidence,
          hosts: evidence.hosts.map((host, index) =>
            index === 0 ? { ...host, tools: host.tools.slice(1) } : host,
          ),
        },
        gate: { id: "mcp_host_interoperability" },
        releaseSha,
      }),
    /must run the exact fixed 16-tool suite/u,
  );
});

test("requires public MCP rotation, revocation, and negative-security drills", () => {
  const drill = { result: "pass", observed_at: observedAt };
  const evidence = {
    schema_version: "1",
    gate: "public_mcp_edge",
    release_sha: releaseSha,
    result: "pass",
    observed_at: observedAt,
    mcp_url: "https://mcp.alphanet.example/mcp",
    issuer_url: "https://auth.alphanet.example",
    jwks_url: "https://auth.alphanet.example/.well-known/jwks.json",
    checks: {
      public_mtls: true,
      jwks: true,
      authorization_code: true,
      refresh: true,
      revocation: true,
      failure_drills: true,
    },
    negative_checks: {
      wrong_resource_rejected: true,
      pkce_plain_rejected: true,
      invalid_redirect_rejected: true,
      untrusted_client_certificate_rejected: true,
      revoked_grant_rejected: true,
      refresh_reuse_rejected: true,
    },
    drills: {
      mtls_rotation: drill,
      jwks_rotation: drill,
      grant_revocation: drill,
      refresh_reuse: drill,
    },
    contains_credentials_or_content: false,
  };

  assert.doesNotThrow(() =>
    validateGateEvidence({
      evidence,
      gate: { id: "public_mcp_edge" },
      releaseSha,
    }),
  );

  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          ...evidence,
          drills: { ...evidence.drills, refresh_reuse: { result: "missing" } },
        },
        gate: { id: "public_mcp_edge" },
        releaseSha,
      }),
    /refresh_reuse drill must pass/u,
  );
});

test("requires approved, versioned, publicly available legal policies", () => {
  const effectivePolicy = { version: "2026-07-24", effective_at: observedAt };
  const evidence = {
    schema_version: "1",
    gate: "legal_policy",
    release_sha: releaseSha,
    result: "pass",
    observed_at: observedAt,
    terms_url: "https://alphanet.example/legal/terms",
    privacy_url: "https://alphanet.example/legal/privacy",
    notice_at_collection_url: "https://alphanet.example/legal/collection-notice",
    community_policy_url: "https://alphanet.example/legal/community",
    copyright_policy_url: "https://alphanet.example/legal/copyright",
    data_request_url: "https://alphanet.example/legal/data-requests",
    developer_terms_url: "https://alphanet.example/legal/developer-terms",
    legal_review: {
      approved: true,
      approver: "External counsel",
      reviewed_at: observedAt,
      memo_reference: "private-legal-review-2026-07",
      scopes: ["copyright", "investment_and_marketing", "privacy", "terms_and_ugc"],
    },
    policy_versions: {
      community: effectivePolicy,
      copyright: effectivePolicy,
      data_request: effectivePolicy,
      developer_terms: effectivePolicy,
      notice_at_collection: effectivePolicy,
      privacy: effectivePolicy,
      terms: effectivePolicy,
    },
    contains_privileged_or_personal_data: false,
  };

  assert.doesNotThrow(() =>
    validateGateEvidence({
      evidence,
      gate: { id: "legal_policy" },
      releaseSha,
    }),
  );

  assert.throws(
    () =>
      validateGateEvidence({
        evidence: {
          ...evidence,
          legal_review: { ...evidence.legal_review, approved: false },
        },
        gate: { id: "legal_policy" },
        releaseSha,
      }),
    /legal review must be approved/u,
  );
});
