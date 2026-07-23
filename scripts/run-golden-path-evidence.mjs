#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  requireReleaseSha,
  requireTargetEnvironment,
  writePrivateJson,
} from "./release-evidence-utils.mjs";

function requiredSecretEnvironment(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
}

function serviceUrl(value, name, protocols) {
  requiredSecretEnvironment(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute service URL.`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error(`${name} must use a non-local release dependency.`);
  }
  return url;
}

export function requireRemoteDependencyUrls({ databaseUrl, redisUrl }) {
  const database = serviceUrl(databaseUrl, "DATABASE_URL", ["postgres:", "postgresql:"]);
  const redis = serviceUrl(redisUrl, "REDIS_URL", ["rediss:"]);
  return {
    databaseHostname: database.hostname,
    redisHostname: redis.hostname,
  };
}

export function buildGoldenPathEvidence({
  durationMilliseconds,
  observedAt,
  releaseSha,
  targetEnvironment,
}) {
  const normalizedReleaseSha = requireReleaseSha(releaseSha);
  const normalizedTarget = requireTargetEnvironment(targetEnvironment);
  if (/^local(?:host|-test)?$/iu.test(normalizedTarget)) {
    throw new Error("Golden-path release evidence requires a non-local environment.");
  }
  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
    throw new Error("durationMilliseconds must be non-negative.");
  }
  const observedEpoch = Date.parse(observedAt);
  if (!Number.isFinite(observedEpoch)) {
    throw new Error("observedAt must be an ISO-8601 timestamp.");
  }

  return {
    schema_version: "1",
    gate: "golden_path",
    release_sha: normalizedReleaseSha,
    target_environment: normalizedTarget,
    result: "pass",
    observed_at: new Date(observedEpoch).toISOString(),
    owner_count: 2,
    surfaces: ["Web", "REST", "Remote MCP"],
    loops: ["owner_web_first", "remote_mcp_first"],
    social_loop_complete: true,
    durable_state_match: true,
    checks: {
      independent_owner_identities: true,
      owner_web_post_mcp_reply_rest_read: true,
      mcp_post_owner_web_reply_rest_read: true,
      reactions_and_revisions_shared: true,
      postgres_facts_match_surface_reads: true,
    },
    duration_ms: Math.round(durationMilliseconds),
    contains_credentials_or_content: false,
  };
}

async function runGoldenPathTest(environment) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now();
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "tests/integration/mvp-cross-surface-golden-path.test.ts",
        "--config",
        "vitest.integration.config.ts",
      ],
      {
        env: {
          ...environment,
          REQUIRE_INTEGRATION_SERVICES: "true",
        },
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`Golden-path integration test failed with exit ${code}.`),
        );
        return;
      }
      resolvePromise(Math.max(0, performance.now() - startedAt));
    });
  });
}

export async function runGoldenPathEvidence(config) {
  requireRemoteDependencyUrls({
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
  });
  const durationMilliseconds = await runGoldenPathTest(process.env);
  return buildGoldenPathEvidence({
    durationMilliseconds,
    observedAt: new Date().toISOString(),
    releaseSha: config.releaseSha,
    targetEnvironment: config.targetEnvironment,
  });
}

async function main() {
  const evidence = await runGoldenPathEvidence({
    releaseSha: process.env.RELEASE_SHA,
    targetEnvironment: process.env.TARGET_ENV,
  });
  const outputPath = resolve(
    process.env.GOLDEN_PATH_EVIDENCE_PATH ?? "artifacts/release/golden-path.json",
  );
  await writePrivateJson(outputPath, evidence);
  process.stdout.write(`golden path evidence: ${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
