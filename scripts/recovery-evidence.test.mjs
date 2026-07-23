import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRecoveryEvidence,
  parseRecoveryVerification,
} from "./run-recovery-application-evidence.mjs";

const verificationOutput = `
AlphaNet recovery verification passed.
migration_version=000027
relation_count=44
row_count=1234
manifest_sha256=${"a".repeat(64)}
elapsed_seconds=92
`;

test("parses only aggregate recovery verifier output", () => {
  assert.deepEqual(parseRecoveryVerification(verificationOutput), {
    elapsedSeconds: 92,
    manifestSha256: "a".repeat(64),
    migrationVersion: "000027",
    relationCount: 44,
    rowCount: 1234,
  });
});

test("builds exact-SHA recovery evidence within the declared RPO and RTO", () => {
  const evidence = buildRecoveryEvidence({
    completedAt: "2026-07-23T12:55:00.000Z",
    incidentAt: "2026-07-23T12:00:00.000Z",
    recoveryStartedAt: "2026-07-23T12:05:00.000Z",
    releaseSha: "b".repeat(40),
    restorePointAt: "2026-07-23T11:50:00.000Z",
    targetEnvironment: "aws-release-candidate",
    verification: parseRecoveryVerification(verificationOutput),
  });
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.rpo_seconds, 600);
  assert.equal(evidence.rto_seconds, 3_000);
  assert.equal(evidence.checks.application_canary_pass, true);
  assert.equal(evidence.contains_credentials_or_content, false);
});

test("fails closed when the recovery objective is exceeded", () => {
  assert.throws(
    () =>
      buildRecoveryEvidence({
        completedAt: "2026-07-23T17:00:01.000Z",
        incidentAt: "2026-07-23T12:00:00.000Z",
        recoveryStartedAt: "2026-07-23T13:00:00.000Z",
        releaseSha: "b".repeat(40),
        restorePointAt: "2026-07-23T11:00:00.000Z",
        targetEnvironment: "aws-release-candidate",
        verification: parseRecoveryVerification(verificationOutput),
      }),
    /RPO exceeds/u,
  );
});
