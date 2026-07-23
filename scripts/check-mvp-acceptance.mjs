#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const acceptanceHeadingPattern = /^###\s+(AC-[A-Z]{2}-\d{2}[A-Z]?)：.+$/gmu;
const acceptanceRowPattern = /^\|\s*(AC-[A-Z]{2}-\d{2}[A-Z]?)\s*\|/u;

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
  return seen;
}

export function extractAcceptanceIds(markdown) {
  return [...markdown.matchAll(acceptanceHeadingPattern)].map((match) => match[1]);
}

export function classifyTraceabilityStatus(status) {
  if (status.startsWith("工程已验证")) return "repository_verified";
  if (status.includes("待发布")) return "release_evidence_required";
  if (status.startsWith("产品批准差异")) return "approved_difference";
  throw new Error(`Unsupported traceability status: ${status}`);
}

export function extractTraceabilityRows(markdown) {
  return markdown
    .split(/\r?\n/u)
    .filter((line) => acceptanceRowPattern.test(line))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.length < 3) throw new Error(`Malformed traceability row: ${line}`);
      const id = cells[0];
      const evidence = cells.at(-2);
      const status = cells.at(-1);
      if (!id || !evidence || !status) {
        throw new Error(`Incomplete traceability row: ${line}`);
      }
      if (/\b(?:TBD|TODO)\b/iu.test(evidence)) {
        throw new Error(`${id} still contains placeholder evidence`);
      }
      return {
        evidence,
        id,
        status,
        status_class: classifyTraceabilityStatus(status),
      };
    });
}

function validateGateManifest(manifest) {
  if (manifest.schema_version !== "1") {
    throw new Error("Unsupported MVP release-gate schema version");
  }
  if (!Number.isInteger(manifest.source_acceptance_count)) {
    throw new Error("source_acceptance_count must be an integer");
  }

  const supplementalIds = unique(
    manifest.supplemental_acceptance_ids ?? [],
    "supplemental_acceptance_ids",
  );
  const gateIds = unique(
    (manifest.global_release_gates ?? []).map((gate) => gate.id),
    "global_release_gates",
  );
  const allowedGateClasses = new Set(["repository", "release_candidate", "external"]);
  for (const gate of manifest.global_release_gates ?? []) {
    if (!allowedGateClasses.has(gate.class)) {
      throw new Error(`Gate ${gate.id} has unsupported class ${gate.class}`);
    }
    if (typeof gate.description !== "string" || gate.description.trim().length === 0) {
      throw new Error(`Gate ${gate.id} requires a description`);
    }
  }

  for (const [acceptanceId, ids] of Object.entries(
    manifest.acceptance_release_gates ?? {},
  )) {
    if (!/^AC-[A-Z]{2}-\d{2}[A-Z]?$/u.test(acceptanceId)) {
      throw new Error(`Invalid acceptance_release_gates key ${acceptanceId}`);
    }
    unique(ids, `acceptance_release_gates.${acceptanceId}`);
    for (const gateId of ids) {
      if (!gateIds.has(gateId)) {
        throw new Error(`${acceptanceId} references unknown gate ${gateId}`);
      }
    }
  }

  return { gateIds, supplementalIds };
}

export function buildAcceptanceReport({
  acceptanceMarkdown,
  manifest,
  traceabilityMarkdown,
}) {
  const sourceIds = extractAcceptanceIds(acceptanceMarkdown);
  const sourceSet = unique(sourceIds, "acceptance source");
  const rows = extractTraceabilityRows(traceabilityMarkdown);
  const rowIds = unique(
    rows.map((row) => row.id),
    "traceability matrix",
  );
  const { gateIds, supplementalIds } = validateGateManifest(manifest);

  if (sourceIds.length !== manifest.source_acceptance_count) {
    throw new Error(
      `Expected ${manifest.source_acceptance_count} source ACs, found ${sourceIds.length}`,
    );
  }
  for (const id of sourceSet) {
    if (!rowIds.has(id)) throw new Error(`Traceability matrix is missing ${id}`);
  }
  for (const id of rowIds) {
    if (!sourceSet.has(id) && !supplementalIds.has(id)) {
      throw new Error(`Traceability matrix contains unknown ${id}`);
    }
  }
  for (const id of supplementalIds) {
    if (!rowIds.has(id))
      throw new Error(`Traceability matrix is missing supplemental ${id}`);
  }

  const acceptanceGateMap = manifest.acceptance_release_gates ?? {};
  const requirements = rows.map((row) => {
    const releaseGates = acceptanceGateMap[row.id] ?? [];
    if (
      (row.status_class === "release_evidence_required" ||
        row.status_class === "approved_difference") &&
      releaseGates.length === 0
    ) {
      throw new Error(`${row.id} requires an explicit release gate`);
    }
    return {
      ...row,
      release_gates: releaseGates,
      source: sourceSet.has(row.id) ? "mvp_acceptance" : "supplemental",
    };
  });

  const counts = requirements.reduce(
    (summary, requirement) => {
      summary[requirement.status_class] += 1;
      return summary;
    },
    {
      approved_difference: 0,
      release_evidence_required: 0,
      repository_verified: 0,
    },
  );

  return {
    schema_version: "1",
    acceptance_source: manifest.acceptance_source,
    traceability_source: manifest.traceability_source,
    source_acceptance_count: sourceIds.length,
    supplemental_acceptance_count: supplementalIds.size,
    counts,
    release_gate_count: gateIds.size,
    release_decision: "NO_GO_UNTIL_RUNTIME_EVIDENCE",
    requirements,
    global_release_gates: manifest.global_release_gates,
  };
}

export async function loadAcceptanceReport(repositoryRoot) {
  const manifestPath = resolve(repositoryRoot, "docs/product/mvp-release-gates.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const [acceptanceMarkdown, traceabilityMarkdown] = await Promise.all([
    readFile(resolve(repositoryRoot, manifest.acceptance_source), "utf8"),
    readFile(resolve(repositoryRoot, manifest.traceability_source), "utf8"),
  ]);
  return buildAcceptanceReport({ acceptanceMarkdown, manifest, traceabilityMarkdown });
}

function parseArguments(arguments_) {
  let reportPath;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") continue;
    if (argument === "--report") {
      reportPath = arguments_[index + 1];
      if (!reportPath) throw new Error("--report requires a path");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { reportPath };
}

async function main() {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { reportPath } = parseArguments(process.argv.slice(2));
  const report = await loadAcceptanceReport(repositoryRoot);
  if (reportPath) {
    const resolvedReportPath = resolve(repositoryRoot, reportPath);
    await mkdir(dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
  }
  process.stdout.write(
    `MVP acceptance inventory is coherent: ${report.source_acceptance_count} source ACs, ` +
      `${report.supplemental_acceptance_count} supplemental AC, ` +
      `${report.counts.repository_verified} repository-verified, ` +
      `${report.counts.release_evidence_required} release-evidence required, ` +
      `${report.counts.approved_difference} approved difference.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
