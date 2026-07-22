import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  checkRemoteMcpOAuthResourceReady,
  checkRemoteMcpOAuthSchemaReady,
} from "./runtime.js";

const RESOURCE = "https://mcp.alphanet.example/mcp";

function readinessPool(configuredResource?: string): {
  pool: Pick<Pool, "query">;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn((sql: string, values?: unknown[]) => {
    expect(sql).toContain("from platform.oauth_resource_configuration");
    expect(sql).toContain("where id = true and resource = $1::text");
    expect(values).toEqual([RESOURCE]);
    return Promise.resolve({
      rows: [{ ready: configuredResource === RESOURCE }],
    });
  });
  return {
    pool: { query } as unknown as Pick<Pool, "query">,
    query,
  };
}

describe("Remote MCP OAuth runtime readiness", () => {
  it("requires the complete lifecycle schema before enabling OAuth", async () => {
    const query = vi.fn((sql: string) => {
      expect(sql).toContain("platform.oauth_grant_bootstrap_reconciliations");
      expect(sql).toContain("system.oauth_grant_bootstrap_queue");
      expect(sql).toContain("prevent_oauth_grant_bootstrap_reconciliation_mutation");
      expect(sql).toContain("maintain_oauth_grant_bootstrap_queue");
      expect(sql).toContain("inspect_remote_mcp_oauth_lifecycle_backlog");
      expect(sql).toContain("expire_remote_mcp_oauth_authorization_requests");
      expect(sql).toContain("reconcile_remote_mcp_oauth_grant_bootstraps");
      expect(sql).toContain("purge_terminal_remote_mcp_oauth_authorization_requests");
      expect(sql).toContain("('000020', 'remote_mcp_oauth_lifecycle_maintenance_v1')");
      expect(sql).toContain("select count(*) = 3");
      return Promise.resolve({ rows: [{ ready: true }] });
    });
    const pool = { query } as unknown as Pick<Pool, "query">;

    await expect(checkRemoteMcpOAuthSchemaReady(pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

  it("fails closed when any lifecycle migration, relation, or function is absent", async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [{ ready: false }] }));
    const pool = { query } as unknown as Pick<Pool, "query">;

    await expect(checkRemoteMcpOAuthSchemaReady(pool)).rejects.toThrow(
      "Remote MCP OAuth schema is not ready",
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects readiness when the canonical resource singleton is absent", async () => {
    const { pool, query } = readinessPool();

    await expect(checkRemoteMcpOAuthResourceReady(pool, RESOURCE)).rejects.toThrow(
      "Remote MCP OAuth resource is not ready",
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects readiness when the canonical resource does not match runtime config", async () => {
    const { pool, query } = readinessPool("https://other.alphanet.example/mcp");

    await expect(checkRemoteMcpOAuthResourceReady(pool, RESOURCE)).rejects.toThrow(
      "Remote MCP OAuth resource is not ready",
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("accepts readiness only for the exact canonical resource singleton", async () => {
    const { pool, query } = readinessPool(RESOURCE);

    await expect(
      checkRemoteMcpOAuthResourceReady(pool, RESOURCE),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });
});
