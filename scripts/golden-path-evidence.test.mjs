import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGoldenPathEvidence,
  requireRemoteDependencyUrls,
} from "./run-golden-path-evidence.mjs";

test("records the two-owner bidirectional Web, REST and Remote MCP loop", () => {
  const evidence = buildGoldenPathEvidence({
    durationMilliseconds: 1_234.4,
    observedAt: "2026-07-23T18:00:00.000Z",
    releaseSha: "c".repeat(40),
    targetEnvironment: "aws-release-candidate",
  });
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.owner_count, 2);
  assert.deepEqual(evidence.surfaces, ["Web", "REST", "Remote MCP"]);
  assert.deepEqual(evidence.loops, ["owner_web_first", "remote_mcp_first"]);
  assert.equal(evidence.durable_state_match, true);
  assert.equal(evidence.duration_ms, 1_234);
  assert.equal(evidence.contains_credentials_or_content, false);
});

test("rejects local harness results as release evidence", () => {
  assert.throws(
    () =>
      buildGoldenPathEvidence({
        durationMilliseconds: 1,
        observedAt: "2026-07-23T18:00:00.000Z",
        releaseSha: "c".repeat(40),
        targetEnvironment: "local-test",
      }),
    /requires a non-local environment/u,
  );
});

test("requires encrypted non-local release dependencies", () => {
  assert.deepEqual(
    requireRemoteDependencyUrls({
      databaseUrl:
        "postgresql://candidate:secret@alphanet.cluster.us-west-2.rds.amazonaws.com/alphanet?sslmode=require",
      redisUrl: "rediss://candidate.cache.amazonaws.com:6379",
    }),
    {
      databaseHostname: "alphanet.cluster.us-west-2.rds.amazonaws.com",
      redisHostname: "candidate.cache.amazonaws.com",
    },
  );

  for (const [databaseUrl, redisUrl] of [
    [
      "postgresql://candidate:secret@localhost/alphanet",
      "rediss://candidate.cache.amazonaws.com:6379",
    ],
    [
      "postgresql://candidate:secret@alphanet.cluster.us-west-2.rds.amazonaws.com/alphanet",
      "redis://candidate.cache.amazonaws.com:6379",
    ],
    [
      "postgresql://candidate:secret@alphanet.cluster.us-west-2.rds.amazonaws.com/alphanet",
      "rediss://127.0.0.1:6379",
    ],
  ]) {
    assert.throws(
      () => requireRemoteDependencyUrls({ databaseUrl, redisUrl }),
      /non-local|rediss/u,
    );
  }
});
