#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchJson,
  isRecord,
  nonnegativeInteger,
  percentile,
  positiveInteger,
  requireBaseUrl,
  requireReleaseSha,
  requireTargetEnvironment,
  sleep,
  writePrivateJson,
} from "./release-evidence-utils.mjs";

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function loadNotificationFixture(filePath) {
  const metadata = await stat(filePath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("NOTIFICATION_FIXTURE must not grant group or world permissions.");
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("NOTIFICATION_FIXTURE must be an object.");
  const triggerApiKeys = Array.isArray(parsed.trigger_api_keys)
    ? parsed.trigger_api_keys.map((value, index) =>
        requiredString(value, `trigger_api_keys[${index}]`),
      )
    : [requiredString(parsed.trigger_api_key, "trigger_api_key")];
  if (triggerApiKeys.length === 0) {
    throw new Error("NOTIFICATION_FIXTURE requires at least one trigger key.");
  }
  if (triggerApiKeys.length > 20) {
    throw new Error("NOTIFICATION_FIXTURE cannot contain more than 20 trigger keys.");
  }
  const recipientApiKey = requiredString(parsed.recipient_api_key, "recipient_api_key");
  if (triggerApiKeys.includes(recipientApiKey)) {
    throw new Error("The recipient and trigger credentials must be different.");
  }
  const rootContentId = requiredString(parsed.root_content_id, "root_content_id");
  if (!UUID_PATTERN.test(rootContentId)) {
    throw new Error("root_content_id must be a UUID.");
  }
  return {
    recipientApiKey,
    rootContentId: rootContentId.toLowerCase(),
    triggerApiKeys,
  };
}

function resultContentId(body) {
  if (
    !isRecord(body) ||
    body.status !== "succeeded" ||
    !isRecord(body.result) ||
    typeof body.result.content_id !== "string"
  ) {
    throw new Error("Reply write did not return a direct succeeded content result.");
  }
  return body.result.content_id;
}

function notificationItems(body) {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Notification response does not contain an items array.");
  }
  return body.items;
}

function includesReply(items, replyId) {
  return items.some(
    (item) =>
      isRecord(item) &&
      item.type === "content.reply" &&
      isRecord(item.object) &&
      item.object.id === replyId,
  );
}

export async function runNotificationSloEvidence(config) {
  const releaseSha = requireReleaseSha(config.releaseSha);
  const targetEnvironment = requireTargetEnvironment(config.targetEnvironment);
  const baseUrl = requireBaseUrl(config.baseUrl, {
    allowLocalHttp: config.allowLocalHttp === true,
  });
  const sampleCount = positiveInteger(config.sampleCount, 100, "SAMPLE_COUNT");
  if (sampleCount < 100 && config.allowSmallSample !== true) {
    throw new Error("Release notification evidence requires at least 100 samples.");
  }
  const writeIntervalMilliseconds = nonnegativeInteger(
    config.writeIntervalMilliseconds,
    3_200,
    "WRITE_INTERVAL_MS",
  );
  const pollIntervalMilliseconds = positiveInteger(
    config.pollIntervalMilliseconds,
    1_000,
    "POLL_INTERVAL_MS",
  );
  const visibilityTimeoutMilliseconds = positiveInteger(
    config.visibilityTimeoutMilliseconds,
    60_000,
    "VISIBILITY_TIMEOUT_MS",
  );
  if (visibilityTimeoutMilliseconds < 60_000 && config.allowSmallSample !== true) {
    throw new Error("Release notification evidence requires a 60 second timeout.");
  }

  const fixture = config.fixture;
  const createdAfter = new Date(Date.now() - 2_000).toISOString();
  const latencies = [];
  let previousWriteStartedAt = null;

  for (let index = 0; index < sampleCount; index += 1) {
    if (previousWriteStartedAt !== null) {
      const nextWriteAt = previousWriteStartedAt + writeIntervalMilliseconds;
      if (Date.now() < nextWriteAt) await sleep(nextWriteAt - Date.now());
    }

    const triggerApiKey = fixture.triggerApiKeys[index % fixture.triggerApiKeys.length];
    const writeStartedAt = Date.now();
    previousWriteStartedAt = writeStartedAt;
    const idempotencyKey = `release-${releaseSha.slice(0, 12)}-notification-${index}`;
    const write = await fetchJson(
      `${baseUrl}/v1/content/${encodeURIComponent(fixture.rootContentId)}/replies`,
      {
        body: JSON.stringify({
          body_markdown: `Synthetic notification release evidence ${index + 1}.`,
        }),
        headers: {
          authorization: `Bearer ${triggerApiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-request-id": `${idempotencyKey}-write`,
        },
        method: "POST",
      },
      { timeoutMilliseconds: 15_000 },
    );
    if (write.status !== 201) {
      throw new Error(`Notification trigger ${index + 1} returned HTTP ${write.status}.`);
    }
    const replyId = resultContentId(write.body);

    let visible = false;
    while (Date.now() - writeStartedAt <= visibilityTimeoutMilliseconds) {
      const query = new URLSearchParams({
        types: "content.reply",
        created_after: createdAfter,
        limit: "100",
      });
      const notifications = await fetchJson(
        `${baseUrl}/v1/notifications?${query}`,
        {
          headers: {
            authorization: `Bearer ${fixture.recipientApiKey}`,
            "x-request-id": `${idempotencyKey}-poll`,
          },
          method: "GET",
        },
        { timeoutMilliseconds: 15_000 },
      );
      if (notifications.status !== 200) {
        throw new Error(
          `Notification poll for sample ${index + 1} returned HTTP ${notifications.status}.`,
        );
      }
      if (includesReply(notificationItems(notifications.body), replyId)) {
        latencies.push(Date.now() - writeStartedAt);
        visible = true;
        break;
      }
      await sleep(pollIntervalMilliseconds);
    }
    if (!visible) {
      latencies.push(visibilityTimeoutMilliseconds + 1);
    }
  }

  const thresholdMilliseconds = 60_000;
  const withinThreshold = latencies.filter(
    (latency) => latency <= thresholdMilliseconds,
  ).length;
  const withinThresholdRate = withinThreshold / latencies.length;
  if (withinThresholdRate < 0.99) {
    throw new Error(
      `Notification SLO failed: ${withinThreshold}/${latencies.length} were readable within 60 seconds.`,
    );
  }

  return {
    schema_version: "1",
    gate: "notification_slo",
    release_sha: releaseSha,
    target_environment: targetEnvironment,
    result: "pass",
    observed_at: new Date().toISOString(),
    sample_count: latencies.length,
    threshold_ms: thresholdMilliseconds,
    readable_within_threshold: withinThreshold,
    readable_within_threshold_rate: withinThresholdRate,
    latency_ms: {
      min: Math.min(...latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(...latencies),
    },
    transport_path: "REST write -> worker projection -> REST notification read",
    contains_credentials_or_content: false,
  };
}

async function main() {
  const fixturePath = resolve(
    requiredString(process.env.NOTIFICATION_FIXTURE, "NOTIFICATION_FIXTURE"),
  );
  const fixture = await loadNotificationFixture(fixturePath);
  const evidence = await runNotificationSloEvidence({
    allowLocalHttp: process.env.ALLOW_LOCAL_HTTP === "1",
    allowSmallSample: process.env.ALLOW_SMALL_SAMPLE === "1",
    baseUrl: process.env.BASE_URL,
    fixture,
    pollIntervalMilliseconds:
      process.env.POLL_INTERVAL_MS === undefined
        ? undefined
        : Number(process.env.POLL_INTERVAL_MS),
    releaseSha: process.env.RELEASE_SHA,
    sampleCount:
      process.env.SAMPLE_COUNT === undefined
        ? undefined
        : Number(process.env.SAMPLE_COUNT),
    targetEnvironment: process.env.TARGET_ENV,
    visibilityTimeoutMilliseconds:
      process.env.VISIBILITY_TIMEOUT_MS === undefined
        ? undefined
        : Number(process.env.VISIBILITY_TIMEOUT_MS),
    writeIntervalMilliseconds:
      process.env.WRITE_INTERVAL_MS === undefined
        ? undefined
        : Number(process.env.WRITE_INTERVAL_MS),
  });
  const outputPath = resolve(
    process.env.NOTIFICATION_SLO_EVIDENCE_PATH ??
      "artifacts/release/notification-slo.json",
  );
  await writePrivateJson(outputPath, evidence);
  process.stdout.write(`notification SLO evidence: ${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
