import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLocalDemoConfiguration,
  validateFixtureDefinition,
} from "./ui-demo-fixture.mjs";

const validEnvironment = Object.freeze({
  ALPHANET_ALLOW_UI_DEMO_SEED: "1",
  ALPHANET_UI_DEMO_PASSWORD: "local-password-placeholder",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/alphanet_ui_demo_test",
  NODE_ENV: "development",
});

test("accepts an explicitly opted-in loopback AlphaNet database", () => {
  const result = assertLocalDemoConfiguration(validEnvironment);
  assert.equal(result.databaseName, "alphanet_ui_demo_test");
  assert.equal(result.password, validEnvironment.ALPHANET_UI_DEMO_PASSWORD);
});

test("rejects production, remote, system, and implicit targets", () => {
  const invalidEnvironments = [
    { ...validEnvironment, NODE_ENV: "production" },
    { ...validEnvironment, ALPHANET_ALLOW_UI_DEMO_SEED: "0" },
    {
      ...validEnvironment,
      DATABASE_URL: "postgresql://user:password@database.example.com/alphanet",
    },
    {
      ...validEnvironment,
      DATABASE_URL: "postgresql://user:password@127.0.0.1/postgres",
    },
    { ...validEnvironment, ALPHANET_UI_DEMO_PASSWORD: "too-short" },
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(() => assertLocalDemoConfiguration(environment));
  }
});

test("fixture retains multiple research posts, sources, and nested discussions", () => {
  assert.deepEqual(validateFixtureDefinition(), {
    nestedReplyCount: 3,
    postCount: 4,
    sourceCount: 8,
  });
});
