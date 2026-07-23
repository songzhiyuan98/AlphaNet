import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OwnerAccountDataExportSchema } from "../../packages/contracts/src/index.js";
import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";
import { PostgresAgentConnectionService } from "../../packages/domain/src/agent-connection.js";
import { PostgresOwnerAccountExportService } from "../../packages/domain/src/owner-account-export.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeOwnerAccountExport = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const agentOptions = {
  activeCredentialsPerAgent: 5,
  activeCredentialsPerOwner: 20,
  apiAudience: "urn:alphanet:api:v1",
  apiKeyCurrentPepperVersion: 1,
  apiKeyPeppers: { 1: "owner-export-integration-pepper-material-v1" },
  credentialDefaultTtlDays: 90,
  credentialIssuePerOwner24Hours: 10,
  credentialMaxTtlDays: 365,
  credentialMutationCooldownSeconds: 0,
} as const;

describeOwnerAccountExport("PostgresOwnerAccountExportService", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  const agentService = new PostgresAgentConnectionService(postgres.sql, agentOptions);
  const auditId = randomUUID();
  const exportService = new PostgresOwnerAccountExportService(postgres.sql, {
    idFactory: () => auditId,
  });
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  let ownerId = "";
  let ownerAgentId = "";
  let ownerCredentialId = "";
  let ownerApiKey = "";
  let crossOwnerId = "";
  let crossAgentId = "";
  let crossApiKey = "";

  async function createVerifiedOwner(label: string): Promise<string> {
    const users = await postgres.sql<{ id: string }[]>`
      insert into auth.users (
        name,
        email,
        email_verified,
        created_at,
        updated_at
      )
      values (
        ${`Owner Export ${label}`},
        ${`owner-export-${label}-${marker}@example.test`},
        true,
        clock_timestamp(),
        clock_timestamp()
      )
      returning id::text as id
    `;
    const authUserId = users[0]?.id;
    if (!authUserId) throw new Error("Owner export Auth User was not created");
    const owners = await postgres.sql<{ id: string }[]>`
      select id::text as id
      from platform.owners
      where auth_user_id = ${authUserId}
    `;
    const id = owners[0]?.id;
    if (!id) throw new Error("Owner export Owner projection was not created");
    return id;
  }

  beforeAll(async () => {
    ownerId = await createVerifiedOwner("primary");
    const ownerAgent = await agentService.createAgent(
      ownerId,
      {
        displayName: "Owner Export Research Agent",
        discoveryTags: ["fundamental-research"],
        handle: `export-${marker}`,
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    ownerAgentId = ownerAgent.agent.id;
    const ownerCredential = await agentService.createCredential(
      ownerId,
      ownerAgentId,
      {
        name: "Owner export workflow",
        scopes: ["research:read"],
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    ownerCredentialId = ownerCredential.credential.id;
    ownerApiKey = ownerCredential.apiKey;

    crossOwnerId = await createVerifiedOwner("cross");
    const crossAgent = await agentService.createAgent(
      crossOwnerId,
      {
        displayName: "Cross Owner Export Agent",
        handle: `export-cross-${marker}`,
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    crossAgentId = crossAgent.agent.id;
    const crossCredential = await agentService.createCredential(
      crossOwnerId,
      crossAgentId,
      {
        name: "Cross-owner export workflow",
        scopes: ["research:read"],
      },
      `req_${randomUUID().replaceAll("-", "")}`,
    );
    crossApiKey = crossCredential.apiKey;
  });

  afterAll(async () => {
    await closeDependencies(dependencies);
  });

  it("checks every storage dependency needed for a complete account snapshot", async () => {
    await expect(exportService.checkReady()).resolves.toBeUndefined();
  });

  it("exports only the authenticated Owner data, excludes secrets, and audits the read", async () => {
    const requestId = `req_owner_export_${marker}`;
    const snapshot = await exportService.exportAccountData(ownerId, {
      authenticatedAt: new Date(),
      authenticationAssurance: "fresh_owner_session",
      requestId,
    });
    const parsed = OwnerAccountDataExportSchema.parse({
      ...(snapshot as Record<string, unknown>),
      request_id: requestId,
      schema_version: "1",
    });

    expect(parsed.owner.id).toBe(ownerId);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toMatchObject({
      id: ownerAgentId,
      credentials: [{ id: ownerCredentialId }],
      discovery_tags: ["fundamental-research"],
    });

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(crossOwnerId);
    expect(serialized).not.toContain(crossAgentId);
    expect(serialized).not.toContain(ownerApiKey);
    expect(serialized).not.toContain(crossApiKey);
    expect(serialized).not.toMatch(
      /"(?:(?:secret|password)(?:_digest|_hash)?|session_token|api_key)"\s*:/iu,
    );

    const auditRows = await postgres.sql<
      {
        action: string;
        authentication_assurance: string;
        authorization_snapshot: unknown;
        event_class: string;
        owner_id: string;
        request_id: string;
      }[]
    >`
      select
        action,
        authentication_assurance,
        authorization_snapshot,
        event_class,
        owner_id::text as owner_id,
        request_id
      from platform.action_logs
      where id = ${auditId}
    `;
    expect(auditRows).toEqual([
      {
        action: "owner.account_data_export",
        authentication_assurance: "fresh_owner_session",
        authorization_snapshot: {
          reauthenticated: true,
          resource: "owner_account_data_export",
        },
        event_class: "sensitive_read",
        owner_id: ownerId,
        request_id: requestId,
      },
    ]);
  });

  it("rejects a non-fresh export context before reading account data", async () => {
    await expect(
      exportService.exportAccountData(ownerId, {
        authenticatedAt: new Date(),
        authenticationAssurance: "email_verified_owner_session" as never,
        requestId: `req_owner_export_stale_${marker}`,
      }),
    ).rejects.toMatchObject({
      code: "OWNER_ACCOUNT_EXPORT_UNAVAILABLE",
      statusCode: 503,
    });
  });
});
