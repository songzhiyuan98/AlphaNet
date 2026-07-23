#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchJson,
  isRecord,
  positiveInteger,
  requireBaseUrl,
  requireReleaseSha,
  requireTargetEnvironment,
  writePrivateJson,
} from "./release-evidence-utils.mjs";

function itemIds(body) {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Search success response does not contain an items array.");
  }
  return body.items.map((item) => {
    if (!isRecord(item) || typeof item.content_id !== "string") {
      throw new Error("Search result contains an invalid content_id.");
    }
    return item.content_id;
  });
}

function execution(body) {
  if (!isRecord(body) || !isRecord(body.search_execution)) {
    throw new Error("Search success response is missing search_execution.");
  }
  return body.search_execution;
}

function errorCode(body) {
  return isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
    ? body.error.code
    : null;
}

export async function runSearchDegradationEvidence(config) {
  const releaseSha = requireReleaseSha(config.releaseSha);
  const targetEnvironment = requireTargetEnvironment(config.targetEnvironment);
  const baseUrl = requireBaseUrl(config.baseUrl, {
    allowLocalHttp: config.allowLocalHttp === true,
  });
  const query = config.query?.normalize("NFC").trim() ?? "";
  if (query.length === 0 || query.length > 4_000) {
    throw new Error("SEARCH_QUERY must contain 1-4,000 characters.");
  }
  const limit = positiveInteger(config.limit, 20, "SEARCH_LIMIT");
  if (limit > 100) throw new Error("SEARCH_LIMIT cannot exceed 100.");

  const request = async (mode) =>
    fetchJson(
      `${baseUrl}/v1/public/content/search`,
      {
        body: JSON.stringify({
          query,
          scope: "global",
          search_mode: mode,
          sort: "relevance",
          limit,
        }),
        headers: {
          "content-type": "application/json",
          "x-request-id": `release-${releaseSha.slice(0, 12)}-search-${mode}`,
        },
        method: "POST",
      },
      { timeoutMilliseconds: config.timeoutMilliseconds ?? 15_000 },
    );

  const lexical = await request("lexical");
  if (lexical.status !== 200) {
    throw new Error(`Lexical search returned HTTP ${lexical.status}.`);
  }
  const lexicalExecution = execution(lexical.body);
  if (
    lexicalExecution.requested_mode !== "lexical" ||
    lexicalExecution.effective_mode !== "lexical" ||
    lexicalExecution.degraded !== false ||
    lexicalExecution.degradation_reason !== null
  ) {
    throw new Error("Lexical search did not report a healthy lexical execution.");
  }
  const lexicalIds = itemIds(lexical.body);
  if (lexicalIds.length === 0) {
    throw new Error("SEARCH_QUERY must return at least one lexical result.");
  }

  const hybrid = await request("hybrid");
  if (hybrid.status !== 200) {
    throw new Error(`Hybrid degradation request returned HTTP ${hybrid.status}.`);
  }
  const hybridExecution = execution(hybrid.body);
  if (
    hybridExecution.requested_mode !== "hybrid" ||
    hybridExecution.effective_mode !== "lexical" ||
    hybridExecution.degraded !== true ||
    hybridExecution.degradation_reason !== "VECTOR_UNAVAILABLE"
  ) {
    throw new Error("Hybrid search did not truthfully degrade to lexical search.");
  }
  const hybridIds = itemIds(hybrid.body);
  if (JSON.stringify(hybridIds) !== JSON.stringify(lexicalIds)) {
    throw new Error("Degraded hybrid results differ from the lexical fallback results.");
  }

  const semantic = await request("semantic");
  if (semantic.status !== 503 || errorCode(semantic.body) !== "INDEX_UNAVAILABLE") {
    throw new Error(
      "Semantic search failure must be an explicit HTTP 503 INDEX_UNAVAILABLE response.",
    );
  }

  return {
    schema_version: "1",
    gate: "search_degradation",
    release_sha: releaseSha,
    target_environment: targetEnvironment,
    result: "pass",
    observed_at: new Date().toISOString(),
    query_fingerprint: {
      characters: [...query].length,
      result_count: lexicalIds.length,
    },
    checks: {
      lexical_usable: true,
      hybrid_degraded_to_lexical: true,
      degraded_results_equal_lexical_results: true,
      semantic_failure_explicit: true,
    },
    latency_ms: {
      lexical: Math.round(lexical.durationMilliseconds),
      hybrid: Math.round(hybrid.durationMilliseconds),
      semantic_failure: Math.round(semantic.durationMilliseconds),
    },
    contains_credentials_or_content: false,
  };
}

async function main() {
  const evidence = await runSearchDegradationEvidence({
    allowLocalHttp: process.env.ALLOW_LOCAL_HTTP === "1",
    baseUrl: process.env.BASE_URL,
    limit:
      process.env.SEARCH_LIMIT === undefined
        ? undefined
        : Number(process.env.SEARCH_LIMIT),
    query: process.env.SEARCH_QUERY,
    releaseSha: process.env.RELEASE_SHA,
    targetEnvironment: process.env.TARGET_ENV,
  });
  const outputPath = resolve(
    process.env.SEARCH_DEGRADATION_EVIDENCE_PATH ??
      "artifacts/release/search-degradation.json",
  );
  await writePrivateJson(outputPath, evidence);
  process.stdout.write(`search degradation evidence: ${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
