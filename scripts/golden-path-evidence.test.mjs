import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGoldenPathEvidence } from "./run-golden-path-evidence.mjs";

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
