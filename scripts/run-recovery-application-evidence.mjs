#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  requireReleaseSha,
  requireTargetEnvironment,
  writePrivateJson,
} from "./release-evidence-utils.mjs";

const declaredRpoSeconds = 15 * 60;
const declaredRtoSeconds = 4 * 60 * 60;

function requiredIsoTimestamp(value, name) {
  const candidate = value?.trim() ?? "";
  const epoch = Date.parse(candidate);
  if (!candidate || !Number.isFinite(epoch)) {
    throw new Error(`${name} must be an ISO-8601 timestamp.`);
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseRecoveryVerification(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([a-z0-9_]+)=(.+)$/u.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  const migrationVersion = values.get("migration_version") ?? "";
  const manifestSha256 = values.get("manifest_sha256") ?? "";
  if (!/^[0-9]{6}$/u.test(migrationVersion)) {
    throw new Error("Recovery verification is missing a migration version.");
  }
  if (!/^[0-9a-f]{64}$/u.test(manifestSha256)) {
    throw new Error("Recovery verification is missing a manifest SHA-256.");
  }
  return {
    elapsedSeconds: positiveInteger(values.get("elapsed_seconds"), "elapsed_seconds"),
    manifestSha256,
    migrationVersion,
    relationCount: positiveInteger(values.get("relation_count"), "relation_count"),
    rowCount: Number(values.get("row_count") ?? ""),
  };
}

function nonnegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

export function buildRecoveryEvidence({
  completedAt,
  incidentAt,
  recoveryStartedAt,
  releaseSha,
  restorePointAt,
  targetEnvironment,
  verification,
}) {
  const normalizedReleaseSha = requireReleaseSha(releaseSha);
  const normalizedTarget = requireTargetEnvironment(targetEnvironment);
  if (/^local(?:host|-test)?$/iu.test(normalizedTarget)) {
    throw new Error("Recovery release evidence requires a non-local environment.");
  }
  const incident = requiredIsoTimestamp(incidentAt, "INCIDENT_AT");
  const restorePoint = requiredIsoTimestamp(restorePointAt, "RESTORE_POINT_AT");
  const recoveryStarted = requiredIsoTimestamp(recoveryStartedAt, "RECOVERY_STARTED_AT");
  const completed = requiredIsoTimestamp(completedAt, "completedAt");
  const rpoSeconds = Math.ceil((incident.epoch - restorePoint.epoch) / 1_000);
  const rtoSeconds = Math.ceil((completed.epoch - recoveryStarted.epoch) / 1_000);
  nonnegativeSafeInteger(rpoSeconds, "observed RPO");
  nonnegativeSafeInteger(rtoSeconds, "observed RTO");
  if (rpoSeconds > declaredRpoSeconds) {
    throw new Error("Observed RPO exceeds the declared 15-minute objective.");
  }
  if (rtoSeconds > declaredRtoSeconds) {
    throw new Error("Observed RTO exceeds the declared four-hour objective.");
  }
  nonnegativeSafeInteger(verification.rowCount, "row_count");

  return {
    schema_version: "1",
    gate: "recovery_application",
    release_sha: normalizedReleaseSha,
    target_environment: normalizedTarget,
    result: "pass",
    observed_at: completed.iso,
    checks: {
      backup_manifest_match: true,
      database_invariants_pass: true,
      application_canary_pass: true,
    },
    restore_point_at: restorePoint.iso,
    incident_at: incident.iso,
    recovery_started_at: recoveryStarted.iso,
    rpo_seconds: rpoSeconds,
    declared_rpo_seconds: declaredRpoSeconds,
    rto_seconds: rtoSeconds,
    declared_rto_seconds: declaredRtoSeconds,
    database: {
      migration_version: verification.migrationVersion,
      relation_count: verification.relationCount,
      row_count: verification.rowCount,
      manifest_sha256: verification.manifestSha256,
      logical_verification_seconds: verification.elapsedSeconds,
    },
    contains_credentials_or_content: false,
  };
}

async function runCommand(command, arguments_, environment) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(new Error(`${command} failed with exit ${code}.`));
    });
  });
}

export async function runRecoveryApplicationEvidence(config) {
  const verificationOutput = await runCommand(
    "bash",
    ["db/scripts/verify-restored-backup.sh"],
    process.env,
  );
  const verification = parseRecoveryVerification(verificationOutput);
  await runCommand(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "tests/integration/recovery-application-canary.test.ts",
      "--config",
      "vitest.integration.config.ts",
    ],
    {
      ...process.env,
      REQUIRE_RECOVERY_APPLICATION_CANARY: "true",
    },
  );
  return buildRecoveryEvidence({
    ...config,
    completedAt: new Date().toISOString(),
    verification,
  });
}

async function main() {
  const evidence = await runRecoveryApplicationEvidence({
    incidentAt: process.env.INCIDENT_AT,
    recoveryStartedAt: process.env.RECOVERY_STARTED_AT,
    releaseSha: process.env.RELEASE_SHA,
    restorePointAt: process.env.RESTORE_POINT_AT,
    targetEnvironment: process.env.TARGET_ENV,
  });
  const outputPath = resolve(
    process.env.RECOVERY_APPLICATION_EVIDENCE_PATH ??
      "artifacts/release/recovery-application.json",
  );
  await writePrivateJson(outputPath, evidence);
  process.stdout.write(`recovery application evidence: ${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
