import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRepositoryCiEvidence } from "./write-repository-ci-evidence.mjs";

const successEnvironment = {
  RELEASE_SHA: "a".repeat(40),
  SOURCE_RUN_ID: "123",
  EVENT_NAME: "push",
  ECR_PUBLISH_ENABLED: "true",
  BUILD_RESULT: "success",
  CONTAINER_CHECK_RESULT: "skipped",
  INFRASTRUCTURE_RESULT: "success",
  INTEGRATION_RESULT: "success",
  PUBLISH_RESULT: "success",
  QUALITY_RESULT: "success",
  SECURITY_RESULT: "success",
  WEB_E2E_RESULT: "success",
};

test("writes exact-SHA repository evidence for the required CI surface", () => {
  const evidence = buildRepositoryCiEvidence(successEnvironment);
  assert.equal(evidence.gate, "repository_ci");
  assert.equal(evidence.result, "pass");
  assert.equal(evidence.checks.length, 7);
  assert.equal(evidence.container_delivery_mode, "immutable_ecr_publish");
});

test("fails closed when any required CI result is not successful", () => {
  assert.throws(
    () =>
      buildRepositoryCiEvidence({
        ...successEnvironment,
        INTEGRATION_RESULT: "failure",
      }),
    /integration must equal success/u,
  );
});
