import type { PostgresClient } from "@alphanet/database";
import { describe, expect, it, vi } from "vitest";

import { createSearchIndexContractDependency } from "./search-readiness.js";

describe("Content Search index readiness", () => {
  it("checks the pinned model, queue indexes, and synchronous Revision trigger", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return Promise.resolve([{ ready: true }]);
    }) as unknown as PostgresClient;
    const dependency = createSearchIndexContractDependency(
      sql,
      "amazon.titan-embed-text-v2:0:512",
    );

    await expect(dependency.check()).resolves.toBeUndefined();
    expect(dependency.name).toBe("content-search-index-contract");
    expect(calls[0]?.text).toContain("content_revisions_enqueue_embedding_job");
    expect(calls[0]?.text).toContain("content_embedding_jobs_revision_incomplete_idx");
    expect(calls[0]?.values).toEqual([
      "amazon.titan-embed-text-v2:0:512",
      "amazon.titan-embed-text-v2:0:512",
      "amazon.titan-embed-text-v2:0:512",
    ]);
  });

  it("fails closed when any fixed index contract invariant is absent", async () => {
    const sql = vi.fn(() =>
      Promise.resolve([{ ready: false }]),
    ) as unknown as PostgresClient;
    const dependency = createSearchIndexContractDependency(
      sql,
      "amazon.titan-embed-text-v2:0:512",
    );

    await expect(dependency.check()).rejects.toThrow(/not ready/u);
  });
});
