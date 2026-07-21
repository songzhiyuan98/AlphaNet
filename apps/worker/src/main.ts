import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { loadWorkerEnvironment } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  PostgresOutboxRepository,
} from "@alphanet/database";
import {
  PostgresPendingActionExecutionRepository,
  PostgresResearchWriteService,
} from "@alphanet/domain";
import { createLogger } from "@alphanet/observability";

import { PendingActionWorker } from "./pending-action-worker.js";
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

  try {
    await postgres.check();

    const leaseOwner = `${hostname()}:${process.pid}:${randomUUID()}`;
    const outboxRepository = new PostgresOutboxRepository(
      postgres.sql,
      environment.OUTBOX_CONSUMER_NAME,
    );
    const handlers = new Map<string, OutboxHandler>();
    const worker = new OutboxWorker({
      batchSize: environment.WORKER_BATCH_SIZE,
      beforeClaim: () => postgres.check(),
      handlers,
      leaseOwner,
      logger,
      replayFrom: environment.OUTBOX_REPLAY_FROM,
      repository: outboxRepository,
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
    const pendingActionWorker = new PendingActionWorker({
      batchSize: environment.WORKER_BATCH_SIZE,
      executor: researchWriter,
      logger,
      repository: pendingActionRepository,
    });
    const abortController = new AbortController();

    const runOnce = async () => {
      // Recheck the privacy-critical PostgreSQL runtime setting before either
      // worker can claim unpublished commands or public Outbox data.
      await postgres.check();
      const [outboxCount, pendingActionCount] = await Promise.all([
        worker.runOnce(),
        pendingActionWorker.runOnce(),
      ]);
      return outboxCount + pendingActionCount;
    };

    const shutdown = (signal: string) => {
      logger.info({ signal }, "stopping outbox polling");
      abortController.abort();
    };
    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });

    if (environment.RUN_ONCE) {
      await runOnce();
      return;
    }

    while (!abortController.signal.aborted) {
      const claimed = await runOnce();
      if (claimed === 0) {
        try {
          await delay(environment.WORKER_POLL_INTERVAL_MS, undefined, {
            signal: abortController.signal,
          });
        } catch (error) {
          if (!abortController.signal.aborted) {
            throw error;
          }
        }
      }
    }
  } finally {
    await closeDependencies(dependencies);
  }
}

start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Worker failed to start"}\n`,
  );
  process.exitCode = 1;
});
