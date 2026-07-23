import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  loadNotificationFixture,
  runNotificationSloEvidence,
} from "./run-notification-slo-evidence.mjs";
import { runSearchDegradationEvidence } from "./run-search-degradation-evidence.mjs";

const releaseSha = "a".repeat(40);
let server;
let baseUrl;
let replySequence = 0;
const visibleReplies = new Set();

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === "/v1/public/content/search") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.search_mode === "semantic") {
        json(response, 503, {
          error: { code: "INDEX_UNAVAILABLE", retryable: true },
        });
        return;
      }
      const degraded = body.search_mode === "hybrid";
      json(response, 200, {
        items: [{ content_id: "10000000-0000-4000-8000-000000000001" }],
        search_execution: {
          requested_mode: body.search_mode,
          effective_mode: "lexical",
          degraded,
          degradation_reason: degraded ? "VECTOR_UNAVAILABLE" : null,
        },
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/content/20000000-0000-4000-8000-000000000001/replies"
    ) {
      replySequence += 1;
      const replyId = `30000000-0000-4000-8000-${String(replySequence).padStart(
        12,
        "0",
      )}`;
      visibleReplies.add(replyId);
      json(response, 201, {
        status: "succeeded",
        result: { content_id: replyId },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/notifications") {
      json(response, 200, {
        items: [...visibleReplies].map((replyId) => ({
          type: "content.reply",
          object: { id: replyId },
        })),
      });
      return;
    }

    json(response, 404, { error: { code: "NOT_FOUND" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("captures truthful hybrid-to-lexical degradation evidence", async () => {
  const evidence = await runSearchDegradationEvidence({
    allowLocalHttp: true,
    baseUrl,
    query: "known release fixture",
    releaseSha,
    targetEnvironment: "local-test",
  });

  assert.equal(evidence.result, "pass");
  assert.equal(evidence.gate, "search_degradation");
  assert.equal(evidence.query_fingerprint.result_count, 1);
  assert.equal(evidence.checks.semantic_failure_explicit, true);
  assert.equal(evidence.contains_credentials_or_content, false);
});

test("measures write-to-readable notification latency without persisting secrets", async () => {
  const evidence = await runNotificationSloEvidence({
    allowLocalHttp: true,
    allowSmallSample: true,
    baseUrl,
    fixture: {
      recipientApiKey: "recipient-secret",
      rootContentId: "20000000-0000-4000-8000-000000000001",
      triggerApiKeys: ["trigger-secret"],
    },
    pollIntervalMilliseconds: 1,
    releaseSha,
    sampleCount: 3,
    targetEnvironment: "local-test",
    visibilityTimeoutMilliseconds: 100,
    writeIntervalMilliseconds: 0,
  });

  assert.equal(evidence.result, "pass");
  assert.equal(evidence.sample_count, 3);
  assert.equal(evidence.readable_within_threshold_rate, 1);
  assert.equal(evidence.contains_credentials_or_content, false);
  assert.doesNotMatch(JSON.stringify(evidence), /recipient-secret|trigger-secret/u);
});

test("requires the notification credential fixture to be private", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "alphanet-evidence-"));
  const fixturePath = path.join(directory, "notification.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      recipient_api_key: "recipient-secret",
      root_content_id: "20000000-0000-4000-8000-000000000001",
      trigger_api_key: "trigger-secret",
    }),
  );
  await chmod(fixturePath, 0o644);
  await assert.rejects(
    () => loadNotificationFixture(fixturePath),
    /must not grant group or world permissions/u,
  );

  await chmod(fixturePath, 0o600);
  const fixture = await loadNotificationFixture(fixturePath);
  assert.equal(fixture.triggerApiKeys.length, 1);
});

test("rejects small notification samples outside harness verification", async () => {
  await assert.rejects(
    () =>
      runNotificationSloEvidence({
        allowLocalHttp: true,
        baseUrl,
        fixture: {
          recipientApiKey: "recipient-secret",
          rootContentId: "20000000-0000-4000-8000-000000000001",
          triggerApiKeys: ["trigger-secret"],
        },
        releaseSha,
        sampleCount: 99,
        targetEnvironment: "local-test",
      }),
    /requires at least 100 samples/u,
  );
});
