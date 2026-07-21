import type { OutboxEvent, PostgresClient } from "@alphanet/database";
import { describe, expect, it } from "vitest";

import {
  EmbeddingProviderError,
  TITAN_TEXT_EMBED_V2_INDEX_MODEL,
  type TextEmbeddingProvider,
} from "./bedrock-embedding.js";
import { SearchIndexer, chunkUnicodeText } from "./search-indexer.js";

const jobId = "10000000-0000-4000-8000-000000000001";
const revisionId = "20000000-0000-4000-8000-000000000001";
const eventId = "30000000-0000-4000-8000-000000000001";
const now = new Date("2026-07-21T18:00:00.000Z");
const normalizedVector = Array.from({ length: 512 }, () => 1 / Math.sqrt(512));

interface Query {
  text: string;
  values: unknown[];
}

function fakeSql(responder: (query: Query) => unknown[] | Promise<unknown[]>): {
  calls: Query[];
  sql: PostgresClient;
} {
  const calls: Query[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    calls.push(query);
    return responder(query);
  };
  Object.assign(tag, {
    begin: async <T>(callback: (transaction: typeof tag) => Promise<T>) => callback(tag),
    unsafe: (text: string) => {
      calls.push({ text, values: [] });
      return Promise.resolve([]);
    },
  });
  return { calls, sql: tag as unknown as PostgresClient };
}

function provider(): TextEmbeddingProvider {
  return {
    dimensions: 512,
    indexModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
    modelId: "amazon.titan-embed-text-v2:0",
    embed() {
      return Promise.resolve(normalizedVector);
    },
  };
}

function outbox(payload: Record<string, unknown>): OutboxEvent {
  return {
    aggregateId: "40000000-0000-4000-8000-000000000001",
    aggregateSequence: "1",
    aggregateType: "content",
    attempts: 1,
    eventType: "content.revised",
    eventVersion: 1,
    id: eventId,
    leaseExpiresAt: now,
    maxAttempts: 12,
    occurredAt: now,
    payload,
  };
}

describe("Search index chunking", () => {
  it("uses Unicode code-point offsets and never splits surrogate pairs", () => {
    const text = "研究😀 AMD supply chain and margin evidence across several quarters";
    const points = [...text.normalize("NFKC")];
    const chunks = chunkUnicodeText(text, { maxCodePoints: 32, overlapCodePoints: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(points.slice(chunk.startOffset, chunk.endOffset).join("")).toBe(chunk.text);
      expect(chunk.text).not.toContain("�");
      expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
    }
    expect(chunks[1]!.startOffset).toBeLessThan(chunks[0]!.endOffset);
  });
});

describe("SearchIndexer", () => {
  it("requires the pinned model and a lease beyond provider timeout plus DB margin", () => {
    const harness = fakeSql(() => []);
    expect(
      () =>
        new SearchIndexer(harness.sql, provider(), {
          leaseMilliseconds: 15_000,
          providerTimeoutMilliseconds: 10_000,
        }),
    ).toThrow(/database completion margin/u);
    expect(
      () =>
        new SearchIndexer(
          harness.sql,
          { ...provider(), indexModel: "other-model:512" },
          { embeddingModel: "other-model:512" },
        ),
    ).toThrow(/exactly match/u);
  });

  it("checks the fixed schema contract and emits only numeric queue gauges", async () => {
    const harness = fakeSql((query) => {
      if (query.text.includes("oldest_ready_age_seconds")) {
        return [
          {
            dead_lettered_count: 2,
            expired_lease_count: 1,
            leased_count: 3,
            oldest_ready_age_seconds: 45,
            ready_count: 7,
          },
        ];
      }
      if (query.text.includes("as ready")) return [{ ready: true }];
      return [];
    });
    const indexer = new SearchIndexer(harness.sql, provider());

    await expect(indexer.checkReady()).resolves.toBeUndefined();
    await expect(indexer.inspectQueue()).resolves.toEqual({
      deadLetteredCount: 2,
      expiredLeaseCount: 1,
      leasedCount: 3,
      oldestReadyAgeSeconds: 45,
      readyCount: 7,
    });

    const readiness = harness.calls.find((call) => call.text.includes("as ready"));
    expect(readiness?.text).toContain("content_revisions_enqueue_embedding_job");
    expect(readiness?.text).toContain("content_embedding_jobs_model");
    expect(readiness?.values).toContain(TITAN_TEXT_EMBED_V2_INDEX_MODEL);
  });

  it("accepts a legitimate classification-only revision event as an indexed no-op", async () => {
    const harness = fakeSql(() => []);
    const indexer = new SearchIndexer(harness.sql, provider());
    await expect(
      indexer.enqueueOutboxEvent(
        outbox({ changed_groups: ["symbols", "topics"], revision_id: null }),
      ),
    ).resolves.toBe(true);
    expect(harness.calls).toHaveLength(0);
    await expect(
      indexer.enqueueOutboxEvent(
        outbox({ changed_groups: ["body_markdown"], revision_id: null }),
      ),
    ).rejects.toMatchObject({ code: "INDEX_DATA_INVALID" });
  });

  it("enqueues and claims only through the fenced 000013 functions", async () => {
    let claimCount = 0;
    const harness = fakeSql((query) => {
      if (query.text.includes("claim_content_embedding_jobs")) {
        claimCount += 1;
        return claimCount === 1
          ? [
              {
                attempts: 1,
                embedding_model: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
                id: jobId,
                lease_expires_at: new Date(now.valueOf() + 60_000),
                max_attempts: 8,
                revision_id: revisionId,
              },
            ]
          : [];
      }
      return [];
    });
    const indexer = new SearchIndexer(harness.sql, provider(), {
      tokenFactory: () => Buffer.alloc(32, 9),
    });
    await indexer.enqueueRevision(revisionId, 100);
    const leases = await indexer.claimJobs("search-worker-1", 2);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      embeddingModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      jobId,
      leaseOwner: "search-worker-1",
      revisionId,
    });
    expect(
      harness.calls.some((call) => call.text.includes("enqueue_content_embedding_job")),
    ).toBe(true);
    expect(
      harness.calls.filter((call) => call.text.includes("claim_content_embedding_jobs")),
    ).toHaveLength(2);
    expect(
      harness.calls.some((call) => /status\s*=\s*'processing'/u.test(call.text)),
    ).toBe(false);
  });

  it("persists immutable exact chunks and completes through the fenced function", async () => {
    let renewalsAtEmbed = -1;
    const harness = fakeSql((query) => {
      if (query.text.includes("join platform.content_revisions")) {
        return [{ body_plain_text: "Evidence", id: revisionId, title: "AMD thesis" }];
      }
      if (query.text.includes("renew_content_embedding_job_lease")) {
        return [{ lease_expires_at: new Date(now.valueOf() + 60_000) }];
      }
      if (
        query.text.includes("from system.content_embedding_jobs") &&
        query.text.includes("for update")
      ) {
        return [{ id: jobId }];
      }
      if (query.text.includes("as exact")) return [{ exact: true }];
      if (query.text.includes("select count(*)::integer as count")) return [{ count: 1 }];
      if (query.text.includes("complete_content_embedding_job"))
        return [{ completed: true }];
      return [];
    });
    const orderedProvider: TextEmbeddingProvider = {
      ...provider(),
      embed() {
        renewalsAtEmbed = harness.calls.filter((call) =>
          call.text.includes("renew_content_embedding_job_lease"),
        ).length;
        return Promise.resolve(normalizedVector);
      },
    };
    const indexer = new SearchIndexer(harness.sql, orderedProvider);
    await indexer.processJob({
      attempts: 1,
      embeddingModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
      jobId,
      leaseExpiresAt: new Date(now.valueOf() + 60_000),
      leaseOwner: "search-worker-1",
      leaseToken: Buffer.alloc(32, 7).toString("base64url"),
      maxAttempts: 8,
      revisionId,
    });
    const insert = harness.calls.find((call) =>
      call.text.includes("insert into platform.content_embedding_chunks"),
    );
    expect(insert?.text).toContain("source_start_offset");
    expect(insert?.text).toContain(
      "on conflict (revision_id, embedding_model, chunk_index) do nothing",
    );
    expect(
      harness.calls.some((call) => call.text.includes("persisted.embedding =")),
    ).toBe(true);
    expect(
      harness.calls.some((call) => call.text.includes("complete_content_embedding_job")),
    ).toBe(true);
    expect(
      harness.calls.some((call) =>
        /delete from platform\.content_embedding_chunks/iu.test(call.text),
      ),
    ).toBe(false);
    expect(harness.calls.some((call) => /do update/iu.test(call.text))).toBe(false);
    expect(renewalsAtEmbed).toBe(1);
    expect(
      harness.calls.filter((call) =>
        call.text.includes("renew_content_embedding_job_lease"),
      ),
    ).toHaveLength(2);
  });

  it("claims each job only after the previous job finishes", async () => {
    let claimCount = 0;
    const harness = fakeSql((query) => {
      if (query.text.includes("claim_content_embedding_jobs")) {
        claimCount += 1;
        return claimCount === 1
          ? [
              {
                attempts: 1,
                embedding_model: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
                id: jobId,
                lease_expires_at: new Date(now.valueOf() + 60_000),
                max_attempts: 8,
                revision_id: revisionId,
              },
            ]
          : [];
      }
      if (query.text.includes("join platform.content_revisions")) {
        return [{ body_plain_text: "Evidence", id: revisionId, title: "AMD thesis" }];
      }
      if (query.text.includes("renew_content_embedding_job_lease")) {
        return [{ lease_expires_at: new Date(now.valueOf() + 60_000) }];
      }
      if (
        query.text.includes("from system.content_embedding_jobs") &&
        query.text.includes("for update")
      ) {
        return [{ id: jobId }];
      }
      if (query.text.includes("as exact")) return [{ exact: true }];
      if (query.text.includes("select count(*)::integer as count")) {
        return [{ count: 1 }];
      }
      if (query.text.includes("complete_content_embedding_job")) {
        return [{ completed: true }];
      }
      return [];
    });
    const indexer = new SearchIndexer(harness.sql, provider(), {
      tokenFactory: () => Buffer.alloc(32, 9),
    });

    await expect(indexer.runOnce("search-worker-1", { batchSize: 3 })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });

    const claimIndexes = harness.calls.flatMap((call, index) =>
      call.text.includes("claim_content_embedding_jobs") ? [index] : [],
    );
    const completionIndex = harness.calls.findIndex((call) =>
      call.text.includes("complete_content_embedding_job"),
    );
    expect(claimIndexes).toHaveLength(2);
    expect(completionIndex).toBeGreaterThan(claimIndexes[0]!);
    expect(completionIndex).toBeLessThan(claimIndexes[1]!);
  });

  it("retries an embedding request aborted during worker shutdown", async () => {
    const harness = fakeSql((query) => {
      if (query.text.includes("join platform.content_revisions")) {
        return [{ body_plain_text: "Evidence", id: revisionId, title: null }];
      }
      if (query.text.includes("renew_content_embedding_job_lease")) {
        return [{ lease_expires_at: new Date(now.valueOf() + 60_000) }];
      }
      return [];
    });
    const abortedProvider: TextEmbeddingProvider = {
      ...provider(),
      embed() {
        return Promise.reject(new EmbeddingProviderError("ABORTED"));
      },
    };
    const indexer = new SearchIndexer(harness.sql, abortedProvider);

    await expect(
      indexer.processJob({
        attempts: 1,
        embeddingModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
        jobId,
        leaseExpiresAt: new Date(now.valueOf() + 60_000),
        leaseOwner: "search-worker-1",
        leaseToken: Buffer.alloc(32, 7).toString("base64url"),
        maxAttempts: 8,
        revisionId,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ABORTED", retryable: true });

    const retry = harness.calls.find((call) =>
      call.text.includes("retry_content_embedding_job"),
    );
    expect(retry?.values).toContain("PROVIDER_ABORTED");
    expect(retry?.values).not.toContain("NONRETRYABLE_PROVIDER_ABORTED");
  });

  it("retries unknown storage failures without classifying index data as invalid", async () => {
    const harness = fakeSql((query) => {
      if (query.text.includes("join platform.content_revisions")) {
        return [{ body_plain_text: "Evidence", id: revisionId, title: null }];
      }
      if (query.text.includes("renew_content_embedding_job_lease")) {
        return [{ lease_expires_at: new Date(now.valueOf() + 60_000) }];
      }
      if (
        query.text.includes("from system.content_embedding_jobs") &&
        query.text.includes("for update")
      ) {
        throw new Error("connection reset");
      }
      return [];
    });
    const indexer = new SearchIndexer(harness.sql, provider());

    await expect(
      indexer.processJob({
        attempts: 1,
        embeddingModel: TITAN_TEXT_EMBED_V2_INDEX_MODEL,
        jobId,
        leaseExpiresAt: new Date(now.valueOf() + 60_000),
        leaseOwner: "search-worker-1",
        leaseToken: Buffer.alloc(32, 7).toString("base64url"),
        maxAttempts: 8,
        revisionId,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", retryable: true });

    const retry = harness.calls.find((call) =>
      call.text.includes("retry_content_embedding_job"),
    );
    expect(retry?.values).toContain("STORAGE_UNAVAILABLE");
    expect(retry?.values).not.toContain("NONRETRYABLE_STORAGE_UNAVAILABLE");
  });

  it("does not treat an existing dead-letter job as a newly backfilled revision", async () => {
    const harness = fakeSql(() => []);
    const indexer = new SearchIndexer(harness.sql, provider());

    await expect(indexer.backfillMissingRevisions()).resolves.toBe(0);
    const backfill = harness.calls.find((call) => call.text.includes("with missing as"));
    expect(backfill?.text).toContain("from system.content_embedding_jobs as job");
    expect(backfill?.text).not.toContain("job.status");
  });
});
