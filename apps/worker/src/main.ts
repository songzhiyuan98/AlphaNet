import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { loadWorkerEnvironment } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  PostgresOutboxRepository,
} from "@alphanet/database";
import {
  BedrockTitanV2EmbeddingProvider,
  NOTIFICATION_OUTBOX_EVENT_TYPES,
  PostgresPendingActionExecutionRepository,
  PostgresNotificationProjector,
  PostgresResearchWriteService,
  SearchIndexer,
} from "@alphanet/domain";
import { AwsBedrockInvokeModelTransport } from "@alphanet/integrations";
import { createLogger } from "@alphanet/observability";

import { ContentRankingSnapshotMaintenance } from "./content-ranking-snapshot-maintenance.js";
import { ContentSearchSnapshotMaintenance } from "./content-search-snapshot-maintenance.js";
import { NotificationRetentionMaintenance } from "./notification-retention-maintenance.js";
import { PendingActionWorker } from "./pending-action-worker.js";
import {
  runSupervisedWorkerLoops,
  type SupervisedWorkerLoop,
} from "./supervised-worker-loops.js";
import { OutboxWorker, type OutboxHandler } from "./worker.js";

async function start(): Promise<void> {
  const environment = loadWorkerEnvironment();
  const logger = createLogger({
    service: "worker",
    environment: environment.NODE_ENV,
    level: environment.LOG_LEVEL,
  });
  const postgres = createPostgresDependency(environment.DATABASE_URL);
  const dependencies = [postgres];
  const bedrockTransport =
    environment.SEARCH_EMBEDDING_PROVIDER === "bedrock"
      ? new AwsBedrockInvokeModelTransport()
      : null;
  const searchEmbeddingProvider = bedrockTransport
    ? new BedrockTitanV2EmbeddingProvider(bedrockTransport, {
        dimensions: environment.SEARCH_EMBEDDING_DIMENSIONS,
        modelId: environment.SEARCH_EMBEDDING_MODEL_ID,
        normalize: true,
        timeoutMilliseconds: environment.SEARCH_EMBEDDING_TIMEOUT_MS,
      })
    : null;

  try {
    await postgres.check();

    const leaseOwner = `${hostname()}:${process.pid}:${randomUUID()}`;
    const outboxRepository = new PostgresOutboxRepository(
      postgres.sql,
      environment.OUTBOX_CONSUMER_NAME,
    );
    const notificationConsumerName = `${environment.OUTBOX_CONSUMER_NAME}.notifications:v1`;
    if (notificationConsumerName.length > 120) {
      throw new RangeError(
        "The versioned Notification Outbox consumer name exceeds 120 characters.",
      );
    }
    const notificationOutboxRepository = new PostgresOutboxRepository(
      postgres.sql,
      notificationConsumerName,
    );
    const notificationProjector = new PostgresNotificationProjector(postgres.sql);
    const searchIndexer = searchEmbeddingProvider
      ? new SearchIndexer(postgres.sql, searchEmbeddingProvider, {
          embeddingModel: `${environment.SEARCH_EMBEDDING_MODEL_ID}:${environment.SEARCH_EMBEDDING_DIMENSIONS}`,
          leaseMilliseconds: environment.SEARCH_INDEX_LEASE_SECONDS * 1_000,
          providerTimeoutMilliseconds: environment.SEARCH_EMBEDDING_TIMEOUT_MS,
          queryTimeoutMilliseconds: Math.min(
            environment.SEARCH_EMBEDDING_TIMEOUT_MS,
            10_000,
          ),
        })
      : null;
    const handlers = new Map<string, OutboxHandler>();
    if (searchIndexer) {
      const enqueueForSearch: OutboxHandler = async (event) => ({
        accepted: await searchIndexer.enqueueOutboxEvent(event),
      });
      handlers.set("content.published", enqueueForSearch);
      handlers.set("content.reply", enqueueForSearch);
      handlers.set("content.revised", enqueueForSearch);
    }
    const worker = new OutboxWorker({
      batchSize: environment.WORKER_BATCH_SIZE,
      beforeClaim: () => postgres.check(),
      handlers,
      leaseOwner,
      logger,
      replayFrom: environment.OUTBOX_REPLAY_FROM,
      repository: outboxRepository,
    });
    const notificationHandlers = new Map<string, OutboxHandler>();
    const projectNotification: OutboxHandler = async (event) => {
      const result = await notificationProjector.project(event);
      return {
        accepted: result.accepted,
        projected: result.projected,
        source_event_id: result.sourceEventId,
      };
    };
    for (const eventType of NOTIFICATION_OUTBOX_EVENT_TYPES) {
      notificationHandlers.set(eventType, projectNotification);
    }
    const notificationOutboxWorker = new OutboxWorker({
      batchSize: environment.WORKER_BATCH_SIZE,
      beforeClaim: () => postgres.check(),
      handlers: notificationHandlers,
      leaseOwner,
      logger,
      replayFrom: environment.OUTBOX_REPLAY_FROM,
      repository: notificationOutboxRepository,
    });
    const pendingActionKeys: Record<number, Uint8Array> = Object.fromEntries([
      ...Object.entries(environment.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).map(
        ([version, key]) => [Number(version), Buffer.from(key, "hex")] as const,
      ),
      [
        environment.PENDING_ACTION_ENCRYPTION_KEY_VERSION,
        Buffer.from(environment.PENDING_ACTION_ENCRYPTION_KEY, "hex"),
      ],
    ]);
    const researchWriter = new PostgresResearchWriteService(postgres.sql, {
      pendingActionKeyRing: {
        currentVersion: environment.PENDING_ACTION_ENCRYPTION_KEY_VERSION,
        keys: pendingActionKeys,
      },
    });
    const pendingActionRepository = new PostgresPendingActionExecutionRepository(
      postgres.sql,
      {
        claimBatchSize: environment.WORKER_BATCH_SIZE,
        leaseOwner,
        reapBatchSize: environment.WORKER_BATCH_SIZE,
      },
    );
    await researchWriter.checkReady();
    await pendingActionRepository.checkReady();
    await notificationProjector.checkReady();
    if (searchIndexer) {
      await searchIndexer.checkReady();
      await searchIndexer.backfillMissingRevisions();
    }
    const pendingActionWorker = new PendingActionWorker({
      batchSize: environment.WORKER_BATCH_SIZE,
      executor: researchWriter,
      logger,
      repository: pendingActionRepository,
    });
    const contentRankingSnapshotMaintenance = new ContentRankingSnapshotMaintenance({
      logger,
      sql: postgres.sql,
    });
    const contentSearchSnapshotMaintenance = new ContentSearchSnapshotMaintenance({
      logger,
      sql: postgres.sql,
    });
    const notificationRetentionMaintenance = new NotificationRetentionMaintenance({
      logger,
      sql: postgres.sql,
    });
    const abortController = new AbortController();
    let nextSearchQueueObservationAt = 0;

    const runCoreOnce = async () => {
      // Recheck the privacy-critical PostgreSQL runtime setting before the
      // core loop can claim unpublished commands or public Outbox data.
      await postgres.check();
      const [
        outboxCount,
        pendingActionCount,
        reconciledSearchEvents,
        purgedSearchEvents,
        purgedRankingCandidateSnapshots,
        purgedCandidateSnapshots,
      ] = await Promise.all([
        worker.runOnce(),
        pendingActionWorker.runOnce(),
        postgres.sql<{ reconciled: number }[]>`
          with stale as (
            select
              event.id,
              least(
                300000::numeric,
                greatest(
                  0::numeric,
                  floor(extract(epoch from (
                    statement_timestamp() - event.occurred_at
                  )) * 1000)
                )
              )::integer as latency_ms
            from platform.agent_search_activity_events as event
            where event.outcome = 'started'
              and event.occurred_at < statement_timestamp() - interval '5 minutes'
              and event.expires_at > statement_timestamp()
            order by event.occurred_at, event.id
            for update skip locked
            limit 1000
          ), reconciled as (
            update platform.agent_search_activity_events as event
            set outcome = 'failed',
                result_count = null,
                latency_ms = stale.latency_ms,
                fallback_reason_code = 'FINALIZATION_RECONCILED'
            from stale
            where event.id = stale.id
              and event.outcome = 'started'
            returning event.id
          )
          select count(*)::integer as reconciled from reconciled
        `,
        postgres.sql<{ purged: number }[]>`
          select platform.purge_expired_agent_search_activity_events(1000) as purged
        `,
        contentRankingSnapshotMaintenance.runOnce(),
        contentSearchSnapshotMaintenance.runOnce(),
      ]);
      return (
        outboxCount +
        pendingActionCount +
        (reconciledSearchEvents[0]?.reconciled ?? 0) +
        (purgedSearchEvents[0]?.purged ?? 0) +
        purgedRankingCandidateSnapshots +
        purgedCandidateSnapshots
      );
    };

    const loops: SupervisedWorkerLoop[] = [{ name: "core", runOnce: runCoreOnce }];
    loops.push({
      name: "notifications",
      runOnce: async () => {
        const [projected, purged] = await Promise.all([
          notificationOutboxWorker.runOnce(),
          notificationRetentionMaintenance.runIfDue(),
        ]);
        return projected + purged;
      },
    });
    if (searchIndexer) {
      const indexer = searchIndexer;
      loops.push({
        name: "search-index",
        runOnce: async (signal) => {
          await postgres.check();
          const observeSearchQueue = Date.now() >= nextSearchQueueObservationAt;
          if (observeSearchQueue) {
            nextSearchQueueObservationAt = Date.now() + 60_000;
          }
          const [searchIndexRun, searchQueueMetrics] = await Promise.all([
            indexer.runOnce(leaseOwner, {
              batchSize: environment.SEARCH_INDEX_BATCH_SIZE,
              signal,
            }),
            observeSearchQueue
              ? indexer.inspectQueue().catch((error: unknown) => {
                  logger.warn(
                    {
                      errorName: error instanceof Error ? error.name : "UnknownError",
                      event: "content_search_index_queue_observation",
                      outcome: "failed",
                    },
                    "Search index queue observation failed",
                  );
                  return null;
                })
              : Promise.resolve(null),
          ]);
          if (searchQueueMetrics) {
            logger.info(
              {
                dead_lettered_count: searchQueueMetrics.deadLetteredCount,
                event: "content_search_index_queue",
                expired_lease_count: searchQueueMetrics.expiredLeaseCount,
                leased_count: searchQueueMetrics.leasedCount,
                oldest_ready_age_seconds: searchQueueMetrics.oldestReadyAgeSeconds,
                ready_count: searchQueueMetrics.readyCount,
              },
              "Search index queue gauges",
            );
          }
          if (searchIndexRun.claimed > 0) {
            logger.info(
              {
                claimed_count: searchIndexRun.claimed,
                completed_count: searchIndexRun.completed,
                event: "content_search_index_batch",
                failed_count: searchIndexRun.failed,
              },
              "Search indexing batch completed",
            );
          }
          if (searchIndexRun.failed > 0) {
            logger.warn(
              {
                claimed: searchIndexRun.claimed,
                completed: searchIndexRun.completed,
                event: "content_search_index_batch_failure",
                failed: searchIndexRun.failed,
              },
              "Search indexing batch completed with failures",
            );
          }
          return searchIndexRun.claimed;
        },
      });
    }

    const shutdown = (signal: string) => {
      logger.info({ signal }, "stopping Worker polling loops");
      abortController.abort();
    };
    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });

    await runSupervisedWorkerLoops({
      abortController,
      loops,
      pollIntervalMilliseconds: environment.WORKER_POLL_INTERVAL_MS,
      runOnce: environment.RUN_ONCE,
    });
  } finally {
    bedrockTransport?.destroy();
    await closeDependencies(dependencies);
  }
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Worker failed to start"}\n`,
  );
  process.exitCode = 1;
});
