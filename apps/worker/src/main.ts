import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { loadWorkerEnvironment } from "@alphanet/config";
import {
  closeDependencies,
  createPostgresDependency,
  PostgresOutboxRepository,
} from "@alphanet/database";
import { createLogger } from "@alphanet/observability";

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
    const repository = new PostgresOutboxRepository(
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
      repository,
    });
    const abortController = new AbortController();

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
      await worker.runOnce();
      return;
    }

    while (!abortController.signal.aborted) {
      const claimed = await worker.runOnce();
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
