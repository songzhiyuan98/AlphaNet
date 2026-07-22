#!/usr/bin/env node

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

const endpoint =
  process.env.ADMIN_WEB_DYNAMODB_ENDPOINT?.trim() || "http://127.0.0.1:58000";
const region = process.env.AWS_REGION?.trim() || "us-west-2";
const tableName =
  process.env.ADMIN_WEB_SESSION_TABLE?.trim() || "alphanet-admin-web-e2e-sessions";

function fail(message) {
  process.stderr.write(`Admin Web E2E table setup failed: ${message}\n`);
  process.exit(2);
}

let endpointUrl;
try {
  endpointUrl = new URL(endpoint);
} catch {
  fail("ADMIN_WEB_DYNAMODB_ENDPOINT must be an absolute URL.");
}
if (
  endpointUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(endpointUrl.hostname) ||
  endpointUrl.pathname !== "/" ||
  endpointUrl.search ||
  endpointUrl.hash
) {
  fail("the setup script is restricted to a loopback DynamoDB Local endpoint.");
}
if (!/^alphanet-admin-web-e2e-[A-Za-z0-9_.-]{1,200}$/u.test(tableName)) {
  fail("ADMIN_WEB_SESSION_TABLE must use the alphanet-admin-web-e2e- prefix.");
}

const client = new DynamoDBClient({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || "DUMMYIDEXAMPLE",
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY?.trim() ||
      "DUMMYEXAMPLEKEYDUMMYEXAMPLEKEY1234567890",
  },
  endpoint: endpointUrl.origin,
  region,
});

async function retry(operation, attempts = 40) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 100)));
    }
  }
  throw lastError;
}

try {
  let created = false;
  const result = await retry(async () => {
    try {
      await client.send(
        new CreateTableCommand({
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          TableName: tableName,
        }),
      );
      return "created";
    } catch (error) {
      if (error instanceof Error && error.name === "ResourceInUseException") {
        return "existing";
      }
      throw error;
    }
  });
  created = result === "created";

  await waitUntilTableExists(
    { client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 },
    { TableName: tableName },
  );
  const description = await client.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  const hashKey = description.Table?.KeySchema?.find((entry) => entry.KeyType === "HASH");
  if (
    description.Table?.TableStatus !== "ACTIVE" ||
    hashKey?.AttributeName !== "pk" ||
    description.Table.KeySchema?.length !== 1
  ) {
    throw new Error("the existing table does not match the Admin session contract");
  }

  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true },
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error.name !== "ValidationException" &&
        error.name !== "TimeToLiveAlreadyEnabledException")
    ) {
      throw error;
    }
  }

  process.stdout.write(
    `${created ? "Created" : "Verified"} DynamoDB Local table ${tableName}.\n`,
  );
} catch (error) {
  process.stderr.write(
    `Admin Web E2E table setup failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
