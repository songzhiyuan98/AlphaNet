#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadAcceptanceReport } from "./check-mvp-acceptance.mjs";
import { isRecord, requireReleaseSha } from "./release-evidence-utils.mjs";

const requiredBrowserProjects = ["chrome", "edge", "firefox", "mobile-safari", "safari"];
const requiredCiChecks = [
  "build",
  "container_delivery",
  "infrastructure",
  "integration",
  "quality",
  "secret_scan",
  "web_e2e",
];
const minimumCapacityDataset = {
  registered_agents: 10_000,
  content_items: 1_000_000,
  posts: 250_000,
  replies: 750_000,
  revisions: 3_000_000,
  reactions: 5_000_000,
  notifications: 3_000_000,
};
const requiredProductValueScenarios = [
  "blind_spot_discovery",
  "counter_thesis",
  "publish_and_discuss",
  "research_follow_up",
  "source_or_claim_validation",
];
const allowedProductValueOutcomes = new Set([
  "hypothesis_changed",
  "hypothesis_rejected",
  "hypothesis_strengthened",
  "new_research_contribution",
  "new_research_question",
]);
const requiredMcpToolNames = [
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validHttpsUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validSecurityContact(value) {
  if (!nonEmptyString(value)) return false;
  if (validHttpsUrl(value)) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function validObservedAt(value) {
  return (
    nonEmptyString(value) &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= Date.now() + 5 * 60 * 1_000
  );
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function validateRepositoryCi(evidence) {
  invariant(
    evidence.source?.provider === "github_actions",
    "source must be GitHub Actions",
  );
  invariant(
    /^[1-9][0-9]*$/u.test(String(evidence.source?.run_id ?? "")),
    "source run_id must be a positive integer",
  );
  invariant(Array.isArray(evidence.checks), "checks must be an array");
  const names = evidence.checks.map((check) => check?.name);
  invariant(
    JSON.stringify(sortedStrings(names)) === JSON.stringify(requiredCiChecks),
    `checks must be exactly ${requiredCiChecks.join(", ")}`,
  );
  invariant(
    evidence.checks.every((check) => check?.result === "success"),
    "every required CI check must succeed",
  );
}

function validateGoldenPath(evidence) {
  invariant(Number.isInteger(evidence.owner_count), "owner_count must be an integer");
  invariant(evidence.owner_count >= 2, "golden path requires at least two Owners");
  invariant(Array.isArray(evidence.surfaces), "surfaces must be an array");
  for (const surface of ["Web", "REST", "Remote MCP"]) {
    invariant(evidence.surfaces.includes(surface), `golden path is missing ${surface}`);
  }
  invariant(evidence.social_loop_complete === true, "social loop must be complete");
  invariant(evidence.durable_state_match === true, "durable state must match");
}

function validateSearchDegradation(evidence) {
  const checks = evidence.checks;
  invariant(isRecord(checks), "checks must be an object");
  for (const name of [
    "lexical_usable",
    "hybrid_degraded_to_lexical",
    "degraded_results_equal_lexical_results",
    "semantic_failure_explicit",
  ]) {
    invariant(checks[name] === true, `${name} must pass`);
  }
  invariant(
    evidence.query_fingerprint?.result_count >= 1,
    "lexical fallback must return at least one result",
  );
  invariant(
    evidence.contains_credentials_or_content === false,
    "evidence must not contain credentials or content",
  );
}

function validateNotificationSlo(evidence) {
  invariant(
    evidence.sample_count >= 100,
    "notification SLO requires at least 100 samples",
  );
  invariant(
    evidence.threshold_ms === 60_000,
    "notification threshold must be 60 seconds",
  );
  invariant(
    evidence.readable_within_threshold_rate >= 0.99,
    "notification readable rate must be at least 99 percent",
  );
  invariant(
    evidence.latency_ms?.p99 <= 60_000,
    "notification p99 must be at most 60 seconds",
  );
  invariant(
    evidence.contains_credentials_or_content === false,
    "evidence must not contain credentials or content",
  );
}

function validateCapacity(evidence) {
  invariant(evidence.profile === "full", "capacity evidence must use the full profile");
  invariant(evidence.passed === true, "capacity thresholds must pass");
  invariant(
    nonEmptyString(evidence.target_environment) &&
      !/^local(?:host|-test)?$/iu.test(evidence.target_environment),
    "capacity evidence requires a non-local target environment",
  );
  invariant(isRecord(evidence.dataset), "capacity evidence requires dataset counts");
  for (const [name, minimum] of Object.entries(minimumCapacityDataset)) {
    invariant(
      Number.isInteger(evidence.dataset[name]) && evidence.dataset[name] >= minimum,
      `capacity dataset ${name} must be at least ${minimum}`,
    );
  }
}

function validateRecovery(evidence) {
  for (const name of [
    "backup_manifest_match",
    "database_invariants_pass",
    "application_canary_pass",
  ]) {
    invariant(evidence.checks?.[name] === true, `${name} must pass`);
  }
  invariant(
    Number.isFinite(evidence.rpo_seconds) &&
      Number.isFinite(evidence.declared_rpo_seconds) &&
      evidence.rpo_seconds <= evidence.declared_rpo_seconds,
    "observed RPO must be within the declared RPO",
  );
  invariant(
    Number.isFinite(evidence.rto_seconds) &&
      Number.isFinite(evidence.declared_rto_seconds) &&
      evidence.rto_seconds <= evidence.declared_rto_seconds,
    "observed RTO must be within the declared RTO",
  );
}

function validateWebCompatibility(evidence) {
  invariant(Array.isArray(evidence.projects), "browser projects must be an array");
  const names = evidence.projects.map((project) => project?.name);
  invariant(
    JSON.stringify(sortedStrings(names)) === JSON.stringify(requiredBrowserProjects),
    `browser projects must be exactly ${requiredBrowserProjects.join(", ")}`,
  );
  invariant(
    evidence.projects.every(
      (project) => project.expected >= 3 && project.unexpected === 0,
    ),
    "every browser project must have complete passing coverage",
  );
  invariant(
    evidence.manual_accessibility_review_required === true,
    "automated evidence must preserve the manual accessibility requirement",
  );
}

function validateManualAccessibility(evidence) {
  for (const name of [
    "keyboard_core_flows",
    "screen_reader_public",
    "screen_reader_owner",
    "screen_reader_admin",
    "admin_review",
  ]) {
    invariant(evidence.checks?.[name] === true, `${name} must pass`);
  }
  invariant(
    Array.isArray(evidence.reviewers) &&
      evidence.reviewers.length >= 1 &&
      evidence.reviewers.every((reviewer) => nonEmptyString(reviewer)),
    "manual accessibility evidence requires an accountable reviewer",
  );
}

function validatePublicMcpEdge(evidence) {
  for (const name of [
    "public_mtls",
    "jwks",
    "authorization_code",
    "refresh",
    "revocation",
    "failure_drills",
  ]) {
    invariant(evidence.checks?.[name] === true, `${name} must pass`);
  }
}

function validateMcpHostInteroperability(evidence) {
  invariant(Array.isArray(evidence.hosts), "hosts must be an array");
  invariant(evidence.hosts.length >= 3, "at least three named MCP Hosts are required");
  invariant(
    new Set(evidence.hosts.map((host) => host?.name)).size === evidence.hosts.length,
    "MCP Host names must be unique",
  );
  for (const host of evidence.hosts) {
    invariant(nonEmptyString(host?.name), "every MCP Host requires a name");
    invariant(nonEmptyString(host?.version), "every MCP Host requires a version");
    invariant(nonEmptyString(host?.platform), "every MCP Host requires a platform");
    invariant(
      nonEmptyString(host?.protocol_version),
      "every MCP Host requires an MCP protocol version",
    );
    invariant(
      host?.transport === "streamable_http",
      "every MCP Host must use Streamable HTTP",
    );
    invariant(
      host?.authorization === "oauth_2_1_pkce",
      "every MCP Host must use OAuth 2.1 with PKCE",
    );
    invariant(host?.result === "pass", "every MCP Host result must pass");
    for (const name of [
      "authorization_challenge",
      "owner_login",
      "agent_selection",
      "tool_discovery",
      "structured_results",
    ]) {
      invariant(host.checks?.[name] === true, `${host.name} ${name} must pass`);
    }
    invariant(Array.isArray(host.tools), `${host.name} tools must be an array`);
    const toolNames = host.tools.map((tool) => tool?.name);
    invariant(
      JSON.stringify(sortedStrings(toolNames)) === JSON.stringify(requiredMcpToolNames),
      `${host.name} must run the exact fixed 16-tool suite`,
    );
    invariant(
      host.tools.every((tool) => tool?.result === "pass"),
      `${host.name} must pass every fixed MCP tool`,
    );
  }
  invariant(
    evidence.contains_credentials_or_content === false,
    "MCP Host evidence must not contain credentials or research content",
  );
}

function validateOperationsReadiness(evidence) {
  invariant(validHttpsUrl(evidence.status_url), "status_url must be a public HTTPS URL");
  invariant(
    validSecurityContact(evidence.security_contact),
    "security_contact must be an email address or public HTTPS URL",
  );
  invariant(nonEmptyString(evidence.on_call_owner), "on_call_owner is required");
  const drill = evidence.incident_drill;
  invariant(drill?.result === "pass", "incident drill must pass");
  invariant(nonEmptyString(drill.scenario), "incident drill scenario is required");
  invariant(nonEmptyString(drill.commander), "incident drill commander is required");
  invariant(nonEmptyString(drill.reviewer), "incident drill reviewer is required");
  invariant(
    drill.commander !== drill.reviewer,
    "incident drill commander and reviewer must be different people",
  );
  invariant(validObservedAt(drill.started_at), "incident drill started_at is invalid");
  invariant(validObservedAt(drill.ended_at), "incident drill ended_at is invalid");
  const startedAt = Date.parse(drill.started_at);
  const endedAt = Date.parse(drill.ended_at);
  invariant(endedAt > startedAt, "incident drill must end after it starts");
  invariant(
    endedAt - startedAt <= 4 * 60 * 60 * 1_000,
    "incident drill must complete within four hours",
  );
  for (const name of [
    "detection",
    "triage",
    "containment",
    "stakeholder_update",
    "recovery",
    "follow_up_ownership",
  ]) {
    invariant(drill.checks?.[name] === true, `incident drill ${name} must pass`);
  }
  invariant(
    evidence.contains_credentials_or_content === false,
    "operations evidence must not contain credentials or user content",
  );
}

function validateLegalPolicy(evidence) {
  for (const name of [
    "terms_url",
    "privacy_url",
    "community_policy_url",
    "copyright_policy_url",
    "data_request_url",
  ]) {
    invariant(validHttpsUrl(evidence[name]), `${name} must be a public HTTPS URL`);
  }
  invariant(evidence.legal_review?.approved === true, "legal review must be approved");
  invariant(
    nonEmptyString(evidence.legal_review?.approver),
    "legal review requires an accountable approver",
  );
}

function validateProductValue(evidence) {
  invariant(Array.isArray(evidence.tasks), "product-value tasks must be an array");
  const passingTasks = evidence.tasks.filter(
    (task) => task?.participant_type === "non_developer" && task?.result === "pass",
  );
  invariant(
    passingTasks.length >= 10,
    "at least ten non-developer market-research tasks must pass",
  );
  invariant(
    new Set(passingTasks.map((task) => task?.task_id)).size === passingTasks.length &&
      passingTasks.every((task) => nonEmptyString(task?.task_id)),
    "passing product-value task IDs must be unique and non-empty",
  );
  invariant(
    passingTasks.every((task) => nonEmptyString(task?.participant_key)),
    "every passing product-value task requires a participant_key",
  );
  invariant(
    new Set(passingTasks.map((task) => task.participant_key)).size >= 5,
    "product-value evidence requires at least five non-developer participants",
  );
  for (const scenario of requiredProductValueScenarios) {
    invariant(
      passingTasks.some((task) => task?.scenario === scenario),
      `product-value evidence is missing scenario ${scenario}`,
    );
  }
  invariant(
    passingTasks.every(
      (task) =>
        task.community_research_used === true &&
        task.independent_verification_completed === true &&
        task.materially_useful === true &&
        allowedProductValueOutcomes.has(task.outcome),
    ),
    "every passing product-value task must use community research, independently verify it, and produce a material research outcome",
  );
  invariant(
    evidence.contains_credentials_or_content === false,
    "product-value evidence must not contain credentials or research content",
  );
}

const gateValidators = {
  repository_ci: validateRepositoryCi,
  golden_path: validateGoldenPath,
  search_degradation: validateSearchDegradation,
  notification_slo: validateNotificationSlo,
  capacity_full: validateCapacity,
  recovery_application: validateRecovery,
  web_compatibility: validateWebCompatibility,
  manual_accessibility: validateManualAccessibility,
  public_mcp_edge: validatePublicMcpEdge,
  mcp_host_interoperability: validateMcpHostInteroperability,
  operations_readiness: validateOperationsReadiness,
  legal_policy: validateLegalPolicy,
  product_value: validateProductValue,
};

export function evidenceFileName(gateId) {
  return `${gateId.replaceAll("_", "-")}.json`;
}

export function validateGateEvidence({ evidence, gate, releaseSha }) {
  invariant(isRecord(evidence), "evidence must be a JSON object");
  invariant(evidence.schema_version === "1", "schema_version must equal 1");
  invariant(evidence.gate === gate.id, `gate must equal ${gate.id}`);
  invariant(evidence.release_sha === releaseSha, "release_sha must match the candidate");
  invariant(evidence.result === "pass", "result must equal pass");
  invariant(
    validObservedAt(evidence.observed_at),
    "observed_at must be a valid timestamp",
  );
  const validator = gateValidators[gate.id];
  invariant(validator, `no validator is registered for ${gate.id}`);
  validator(evidence);
}

export function buildReleaseReport({
  acceptanceReport,
  evidenceByGate,
  manifest,
  releaseSha,
}) {
  requireReleaseSha(releaseSha);
  const gateResults = manifest.global_release_gates.map((gate) => {
    if (gate.id === "product_spec_alignment") {
      const passed =
        acceptanceReport.counts.approved_difference === 0 &&
        acceptanceReport.source_acceptance_count === manifest.source_acceptance_count;
      return {
        class: gate.class,
        evidence_file: null,
        id: gate.id,
        status: passed ? "pass" : "invalid",
        ...(passed
          ? { source: "repository_acceptance_inventory" }
          : { error: "acceptance inventory still contains a product-spec difference" }),
      };
    }

    const evidenceFile = evidenceFileName(gate.id);
    const evidence = evidenceByGate.get(gate.id);
    if (evidence === undefined) {
      return {
        class: gate.class,
        evidence_file: evidenceFile,
        id: gate.id,
        status: "missing",
      };
    }
    try {
      validateGateEvidence({ evidence, gate, releaseSha });
      return {
        class: gate.class,
        evidence_file: evidenceFile,
        id: gate.id,
        observed_at: evidence.observed_at,
        status: "pass",
      };
    } catch (error) {
      return {
        class: gate.class,
        evidence_file: evidenceFile,
        error: error instanceof Error ? error.message : String(error),
        id: gate.id,
        status: "invalid",
      };
    }
  });

  const gateStatus = new Map(gateResults.map((gate) => [gate.id, gate.status]));
  const requirements = acceptanceReport.requirements.map((requirement) => {
    const releaseGates = requirement.release_gates ?? [];
    const releaseGateStatus = Object.fromEntries(
      releaseGates.map((gateId) => [gateId, gateStatus.get(gateId) ?? "missing"]),
    );
    return {
      id: requirement.id,
      release_gate_status: releaseGateStatus,
      status:
        releaseGates.length === 0 ||
        Object.values(releaseGateStatus).every((status) => status === "pass")
          ? "pass"
          : "blocked",
    };
  });
  const decision =
    gateResults.every((gate) => gate.status === "pass") &&
    requirements.every((requirement) => requirement.status === "pass")
      ? "GO"
      : "NO_GO";

  return {
    schema_version: "1",
    release_sha: releaseSha,
    generated_at: new Date().toISOString(),
    decision,
    summary: {
      pass: gateResults.filter((gate) => gate.status === "pass").length,
      missing: gateResults.filter((gate) => gate.status === "missing").length,
      invalid: gateResults.filter((gate) => gate.status === "invalid").length,
      blocked_requirements: requirements.filter(
        (requirement) => requirement.status === "blocked",
      ).length,
    },
    gates: gateResults,
    requirements,
  };
}

async function loadEvidence(evidenceDirectory, gates) {
  const evidenceByGate = new Map();
  for (const gate of gates) {
    if (gate.id === "product_spec_alignment") continue;
    const filePath = resolve(evidenceDirectory, evidenceFileName(gate.id));
    try {
      evidenceByGate.set(gate.id, JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        evidenceByGate.set(gate.id, {
          __parse_error:
            error instanceof Error ? error.message : "unknown evidence read error",
        });
      }
    }
  }
  return evidenceByGate;
}

function parseArguments(arguments_) {
  const parsed = {
    allowNoGo: false,
    evidenceDirectory: "artifacts/release",
    releaseSha: process.env.RELEASE_SHA,
    reportPath: "artifacts/release/mvp-release-decision.json",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-no-go") {
      parsed.allowNoGo = true;
      continue;
    }
    if (["--evidence-dir", "--release-sha", "--report"].includes(argument)) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--evidence-dir") parsed.evidenceDirectory = value;
      if (argument === "--release-sha") parsed.releaseSha = value;
      if (argument === "--report") parsed.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

async function main() {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const arguments_ = parseArguments(process.argv.slice(2));
  const releaseSha = requireReleaseSha(arguments_.releaseSha);
  const manifest = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "docs/product/mvp-release-gates.json"),
      "utf8",
    ),
  );
  const acceptanceReport = await loadAcceptanceReport(repositoryRoot);
  const evidenceByGate = await loadEvidence(
    resolve(repositoryRoot, arguments_.evidenceDirectory),
    manifest.global_release_gates,
  );
  const report = buildReleaseReport({
    acceptanceReport,
    evidenceByGate,
    manifest,
    releaseSha,
  });
  const reportPath = resolve(repositoryRoot, arguments_.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  process.stdout.write(
    `MVP release decision ${report.decision}: ${report.summary.pass} pass, ` +
      `${report.summary.missing} missing, ${report.summary.invalid} invalid; ` +
      `report=${reportPath}\n`,
  );
  if (report.decision !== "GO" && !arguments_.allowNoGo) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
