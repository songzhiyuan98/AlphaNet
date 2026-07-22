import { describe, expect, it } from "vitest";

import {
  REMOTE_MCP_OAUTH_AUTHORIZE_GLOBAL_CEILING_PER_MINUTE,
  REMOTE_MCP_OAUTH_CAPACITY_POLICY,
  REMOTE_MCP_OAUTH_LIFECYCLE_SINGLE_WORKER_ROWS_PER_MINUTE,
  remoteMcpOAuthRowsPerMinute,
} from "./remote-mcp-oauth-capacity.js";

describe("Remote MCP OAuth shared capacity policy", () => {
  it("keeps guaranteed single-Worker lifecycle capacity above admission", () => {
    expect(REMOTE_MCP_OAUTH_AUTHORIZE_GLOBAL_CEILING_PER_MINUTE).toBe(1_200);
    expect(REMOTE_MCP_OAUTH_LIFECYCLE_SINGLE_WORKER_ROWS_PER_MINUTE).toBe(2_000);
    expect(REMOTE_MCP_OAUTH_LIFECYCLE_SINGLE_WORKER_ROWS_PER_MINUTE).toBeGreaterThan(
      REMOTE_MCP_OAUTH_AUTHORIZE_GLOBAL_CEILING_PER_MINUTE,
    );
    expect(
      REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.maximumRowsPerStage,
    ).toBeGreaterThan(REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.batchSize);
    expect(
      REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.maximumRunMilliseconds,
    ).toBeLessThan(REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.intervalMilliseconds);
  });

  it("rejects invalid capacity calculations", () => {
    expect(() => remoteMcpOAuthRowsPerMinute(0, 30_000)).toThrow("positive integers");
    expect(() => remoteMcpOAuthRowsPerMinute(1_000, 0)).toThrow("positive integers");
  });
});
