import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const checkNames = [
  "build",
  "container_delivery",
  "infrastructure",
  "integration",
  "quality",
  "secret_scan",
  "web_e2e",
];

function requiredResult(value, name) {
  if (value !== "success") throw new Error(`${name} must equal success.`);
  return value;
}

export function buildRepositoryCiEvidence(environment) {
  const releaseSha = environment.RELEASE_SHA?.trim() ?? "";
  const sourceRunId = environment.SOURCE_RUN_ID?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be a full lowercase commit SHA.");
  }
  if (!/^[1-9][0-9]*$/u.test(sourceRunId)) {
    throw new Error("SOURCE_RUN_ID must be a positive integer.");
  }
  const usePublishedContainer =
    environment.EVENT_NAME === "push" && environment.ECR_PUBLISH_ENABLED === "true";
  const results = {
    build: environment.BUILD_RESULT,
    container_delivery: usePublishedContainer
      ? environment.PUBLISH_RESULT
      : environment.CONTAINER_CHECK_RESULT,
    infrastructure: environment.INFRASTRUCTURE_RESULT,
    integration: environment.INTEGRATION_RESULT,
    quality: environment.QUALITY_RESULT,
    secret_scan: environment.SECURITY_RESULT,
    web_e2e: environment.WEB_E2E_RESULT,
  };

  return {
    schema_version: "1",
    gate: "repository_ci",
    release_sha: releaseSha,
    result: "pass",
    observed_at: new Date().toISOString(),
    source: {
      provider: "github_actions",
      run_id: sourceRunId,
    },
    checks: checkNames.map((name) => ({
      name,
      result: requiredResult(results[name], name),
    })),
    container_delivery_mode: usePublishedContainer
      ? "immutable_ecr_publish"
      : "local_container_check",
  };
}

async function main() {
  const outputPath =
    process.env.REPOSITORY_CI_EVIDENCE_PATH ?? "artifacts/release/repository-ci.json";
  const evidence = buildRepositoryCiEvidence(process.env);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`repository CI evidence: ${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
