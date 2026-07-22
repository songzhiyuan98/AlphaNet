import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDependencies,
  createPostgresDependency,
  type HealthDependency,
} from "../../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const mustRun = process.env.REQUIRE_INTEGRATION_SERVICES === "true";

if (mustRun && !databaseUrl) {
  throw new Error("DATABASE_URL is required when REQUIRE_INTEGRATION_SERVICES=true");
}

const describeProvisioning = databaseUrl ? describe : describe.skip;
const dependencies: HealthDependency[] = [];
const resource = "http://127.0.0.1:4100/mcp";
const managedMetadata = {
  alphanet_managed: true,
  alphanet_provisioner: "remote_mcp_oauth_clients_v1",
};

interface ManifestClient {
  client_id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  grant_types: string[];
  [key: string]: unknown;
}

interface Manifest {
  schema_version: number;
  resource: string;
  clients: ManifestClient[];
  [key: string]: unknown;
}

interface ProvisionerOptions {
  expectedResource?: string;
  injected?: boolean;
}

function requireDatabaseUrl(): URL {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for this test");
  return new URL(databaseUrl);
}

describeProvisioning("Remote MCP OAuth operator provisioning", () => {
  const postgres = createPostgresDependency(databaseUrl ?? "");
  dependencies.push(postgres);

  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const firstClientId = `alphanet-provision-${marker}-a`;
  const secondClientId = `alphanet-provision-${marker}-b`;
  const unmanagedClientId = `alphanet-provision-${marker}-unmanaged`;
  const partialMarkerClientId = `alphanet-provision-${marker}-partial`;
  const createdClientIds = [
    firstClientId,
    secondClientId,
    unmanagedClientId,
    partialMarkerClientId,
  ];
  let temporaryDirectory = "";

  function publicClient(
    clientId: string,
    options: Partial<ManifestClient> = {},
  ): ManifestClient {
    return {
      client_id: clientId,
      name: `AlphaNet Integration Host ${clientId.at(-1)?.toUpperCase()}`,
      redirect_uris: [
        `http://127.0.0.1:43110/oauth/${clientId}`,
        `https://${clientId}.example.test/oauth/callback`,
      ],
      scopes: ["research:read"],
      grant_types: ["authorization_code"],
      ...options,
    };
  }

  function manifest(clients: ManifestClient[], manifestResource = resource): Manifest {
    return {
      schema_version: 1,
      resource: manifestResource,
      clients,
    };
  }

  async function runProvisioner(
    document: Manifest | string,
    options: ProvisionerOptions = {},
  ): Promise<{ status: number | null; stderr: string; stdout: string }> {
    const rawDocument =
      typeof document === "string" ? document : `${JSON.stringify(document)}\n`;
    const manifestSha256 = createHash("sha256").update(rawDocument).digest("hex");
    const manifestPath = resolve(temporaryDirectory, `manifest-${randomUUID()}.json`);
    await writeFile(manifestPath, rawDocument, { encoding: "utf8", mode: 0o600 });

    const parsedDatabaseUrl = requireDatabaseUrl();
    const user = decodeURIComponent(parsedDatabaseUrl.username);
    const password = decodeURIComponent(parsedDatabaseUrl.password);
    const result = spawnSync(
      "bash",
      [
        resolve(process.cwd(), "db/scripts/aws-reconcile-remote-mcp-oauth-clients.sh"),
      ].concat(options.injected ? [] : [manifestPath]),
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ALPHANET_EXPECTED_OAUTH_RESOURCE: options.expectedResource ?? resource,
          ALPHANET_MIGRATION_ROLE: user,
          ...(options.injected
            ? {
                ALPHANET_OAUTH_MANIFEST_BASE64:
                  Buffer.from(rawDocument).toString("base64"),
                ALPHANET_OAUTH_EXPECTED_APPROVED_SHA256: manifestSha256,
              }
            : {}),
          ALPHANET_OAUTH_MANIFEST_SHA256: manifestSha256,
          PGDATABASE: decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)),
          PGHOST: parsedDatabaseUrl.hostname,
          PGPASSWORD: password,
          PGPORT: parsedDatabaseUrl.port || "5432",
          PGUSER: user,
        },
        timeout: 15_000,
      },
    );
    if (result.error) throw result.error;
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  async function expectRejectedWithoutDocumentValues(
    document: Manifest | string,
    values: string[],
    options: ProvisionerOptions = {},
  ): Promise<void> {
    const result = await runProvisioner(document, options);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Remote MCP OAuth client reconciliation failed; no changes were committed.\n",
    );
    for (const value of values) {
      expect(result.stderr).not.toContain(value);
    }
  }

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "alphanet-oauth-provision-"));

    const configured = await postgres.sql<{ resource: string }[]>`
      select resource
      from platform.oauth_resource_configuration
      where id = true
    `;
    if (configured[0] && configured[0].resource !== resource) {
      throw new Error("The integration database has a different MCP resource");
    }

    await postgres.sql`
      delete from auth.oauth_clients
      where client_id = any(${createdClientIds}::text[])
    `;
    await postgres.sql`
      insert into auth.oauth_clients (
        client_id,
        disabled,
        skip_consent,
        scopes,
        created_at,
        updated_at,
        name,
        redirect_uris,
        token_endpoint_auth_method,
        grant_types,
        response_types,
        public,
        require_pkce,
        metadata
      ) values (
        ${unmanagedClientId},
        false,
        false,
        ${postgres.sql.json(["research:read"])},
        clock_timestamp(),
        clock_timestamp(),
        'External integration client',
        ${postgres.sql.json([
          `https://${unmanagedClientId}.example.test/oauth/callback`,
        ])},
        'none',
        ${postgres.sql.json(["authorization_code"])},
        ${postgres.sql.json(["code"])},
        true,
        true,
        ${postgres.sql.json({ external_operator: true })}
      )
    `;
  });

  afterAll(async () => {
    await postgres.sql`
      delete from auth.oauth_clients
      where client_id = any(${createdClientIds}::text[])
    `;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
    await closeDependencies(dependencies);
  });

  it("atomically reconciles reviewed managed clients and rejects every unsafe path", async () => {
    const unmanagedBefore = await postgres.sql<{ row: unknown }[]>`
      select to_jsonb(client) as row
      from auth.oauth_clients as client
      where client_id = ${unmanagedClientId}
    `;

    const initial = manifest([
      publicClient(firstClientId),
      publicClient(secondClientId, {
        grant_types: ["authorization_code", "refresh_token"],
        scopes: ["research:read", "community:read", "offline_access"],
      }),
    ]);
    const initialResult = await runProvisioner(initial, { injected: true });
    expect(initialResult).toEqual({
      status: 0,
      stderr: "",
      stdout:
        "Remote MCP OAuth resource and public-client allowlist reconciled atomically.\n",
    });

    const configured = await postgres.sql<{ resource: string }[]>`
      select resource
      from platform.oauth_resource_configuration
      where id = true
    `;
    expect(configured).toEqual([{ resource }]);

    const created = await postgres.sql<
      {
        client_id: string;
        client_secret: string | null;
        disabled: boolean;
        grant_types: unknown;
        metadata: unknown;
        public: boolean;
        require_pkce: boolean;
        skip_consent: boolean;
        token_endpoint_auth_method: string;
      }[]
    >`
      select client_id,
             client_secret,
             disabled,
             grant_types,
             metadata,
             public,
             require_pkce,
             skip_consent,
             token_endpoint_auth_method
      from auth.oauth_clients
      where client_id = any(${[firstClientId, secondClientId]}::text[])
      order by client_id
    `;
    expect(created).toEqual([
      {
        client_id: firstClientId,
        client_secret: null,
        disabled: false,
        grant_types: ["authorization_code"],
        metadata: managedMetadata,
        public: true,
        require_pkce: true,
        skip_consent: false,
        token_endpoint_auth_method: "none",
      },
      {
        client_id: secondClientId,
        client_secret: null,
        disabled: false,
        grant_types: ["authorization_code", "refresh_token"],
        metadata: managedMetadata,
        public: true,
        require_pkce: true,
        skip_consent: false,
        token_endpoint_auth_method: "none",
      },
    ]);

    const updatedName = "AlphaNet Integration Host A v2";
    const updateResult = await runProvisioner(
      manifest([
        publicClient(firstClientId, {
          name: updatedName,
          redirect_uris: [`http://127.0.0.1:43111/oauth/${firstClientId}`],
        }),
      ]),
    );
    expect(updateResult.status).toBe(0);
    const reconciled = await postgres.sql<
      { client_id: string; disabled: boolean; name: string }[]
    >`
      select client_id, disabled, name
      from auth.oauth_clients
      where client_id = any(${[firstClientId, secondClientId]}::text[])
      order by client_id
    `;
    expect(reconciled).toEqual([
      { client_id: firstClientId, disabled: false, name: updatedName },
      {
        client_id: secondClientId,
        disabled: true,
        name: "AlphaNet Integration Host B",
      },
    ]);

    const withUnknownField = manifest([
      publicClient(firstClientId, { unreviewed_uri: "https://unexpected.example" }),
    ]);
    await expectRejectedWithoutDocumentValues(withUnknownField, [
      firstClientId,
      "unexpected.example",
    ]);

    const duplicateKeyDocument = `{"schema_version":1,"resource":"${resource}","clients":[{"client_id":"${firstClientId}","client_id":"shadow-client","name":"Duplicate","redirect_uris":["http://127.0.0.1:43111/oauth/callback"],"scopes":["research:read"],"grant_types":["authorization_code"]}]}`;
    await expectRejectedWithoutDocumentValues(duplicateKeyDocument, [
      firstClientId,
      "shadow-client",
    ]);

    await expectRejectedWithoutDocumentValues(
      manifest([publicClient(firstClientId), publicClient(firstClientId)]),
      [firstClientId],
    );

    const unsafeRedirect = `https://trusted.example@evil.example/oauth/callback`;
    await expectRejectedWithoutDocumentValues(
      manifest([publicClient(firstClientId, { redirect_uris: [unsafeRedirect] })]),
      [unsafeRedirect],
    );

    await expectRejectedWithoutDocumentValues(
      manifest([
        publicClient(firstClientId, {
          scopes: ["research:read", "offline_access"],
          grant_types: ["authorization_code"],
        }),
      ]),
      [firstClientId],
    );

    await expectRejectedWithoutDocumentValues(
      manifest([publicClient(firstClientId)], "https://different.example.test/mcp"),
      ["different.example.test"],
    );

    await expectRejectedWithoutDocumentValues(
      manifest([publicClient(firstClientId)]),
      [firstClientId, resource],
      { expectedResource: "https://reviewed-resource.example.test/mcp", injected: true },
    );

    await expectRejectedWithoutDocumentValues(
      manifest([publicClient(unmanagedClientId)]),
      [unmanagedClientId],
    );

    await postgres.sql`
      insert into auth.oauth_clients (
        client_id,
        disabled,
        skip_consent,
        scopes,
        created_at,
        updated_at,
        name,
        redirect_uris,
        token_endpoint_auth_method,
        grant_types,
        response_types,
        public,
        require_pkce,
        metadata
      ) values (
        ${partialMarkerClientId},
        true,
        false,
        ${postgres.sql.json(["research:read"])},
        clock_timestamp(),
        clock_timestamp(),
        'Partial marker client',
        ${postgres.sql.json([
          `https://${partialMarkerClientId}.example.test/oauth/callback`,
        ])},
        'none',
        ${postgres.sql.json(["authorization_code"])},
        ${postgres.sql.json(["code"])},
        true,
        true,
        ${postgres.sql.json({ alphanet_managed: true })}
      )
    `;
    await expectRejectedWithoutDocumentValues(manifest([publicClient(firstClientId)]), [
      partialMarkerClientId,
    ]);
    await postgres.sql`
      delete from auth.oauth_clients
      where client_id = ${partialMarkerClientId}
    `;

    const unchangedAfterFailures = await postgres.sql<
      { disabled: boolean; name: string }[]
    >`
      select disabled, name
      from auth.oauth_clients
      where client_id = ${firstClientId}
    `;
    expect(unchangedAfterFailures).toEqual([{ disabled: false, name: updatedName }]);

    const disableAll = await runProvisioner(manifest([]));
    expect(disableAll.status).toBe(0);
    const disabled = await postgres.sql<{ client_id: string; disabled: boolean }[]>`
      select client_id, disabled
      from auth.oauth_clients
      where client_id = any(${[firstClientId, secondClientId]}::text[])
      order by client_id
    `;
    expect(disabled).toEqual([
      { client_id: firstClientId, disabled: true },
      { client_id: secondClientId, disabled: true },
    ]);

    const unmanagedAfter = await postgres.sql<{ row: unknown }[]>`
      select to_jsonb(client) as row
      from auth.oauth_clients as client
      where client_id = ${unmanagedClientId}
    `;
    expect(unmanagedAfter).toEqual(unmanagedBefore);
  }, 30_000);
});
