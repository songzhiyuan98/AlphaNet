import type { OutboxEvent } from "@alphanet/database";
import { createLogger } from "@alphanet/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxWorker, type WorkerRepository } from "./worker.js";

const event: OutboxEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  aggregateType: "community",
  aggregateId: "general",
  aggregateSequence: "1",
  eventType: "community.created",
  eventVersion: 1,
  leaseExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
  payload: { slug: "general" },
  occurredAt: new Date("2026-07-19T12:00:00.000Z"),
  attempts: 1,
  maxAttempts: 12,
};
const replayFrom = new Date(0);

const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "worker-test",
});

function makeRepository(): WorkerRepository & {
  claim: ReturnType<typeof vi.fn>;
  markDelivered: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  renewLease: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn((options: Parameters<WorkerRepository["claim"]>[0]) =>
      Promise.resolve([
        {
          ...event,
          leaseExpiresAt: new Date(Date.now() + (options.leaseSeconds ?? 30) * 1_000),
        },
      ]),
    ),
    markDelivered: vi.fn(() => Promise.resolve(true)),
    markFailed: vi.fn(() => Promise.resolve(true)),
    renewLease: vi.fn(() => Promise.resolve(true)),
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("OutboxWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges a successfully handled event", async () => {
    const repository = makeRepository();
    const handler = vi.fn((candidate: OutboxEvent) =>
      Promise.resolve({ indexed: candidate.id === event.id }),
    );
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", handler]]),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(repository.claim).toHaveBeenCalledWith({
      batchSize: 20,
      eventTypes: ["community.created"],
      leaseOwner: "worker-1",
      leaseSeconds: 30,
      replayFrom,
    });
    const handledEvent = handler.mock.calls[0]?.[0];
    expect(handledEvent?.id).toBe(event.id);
    expect(handledEvent?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(repository.markDelivered).toHaveBeenCalledWith(event.id, "worker-1", {
      indexed: true,
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("does not claim events before the consumer has a real handler", async () => {
    const repository = makeRepository();
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map(),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await worker.runOnce();

    expect(repository.claim).not.toHaveBeenCalled();
    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("releases a failed event for bounded retry without storing its message", async () => {
    const repository = makeRepository();
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([
        [
          "community.created",
          () => Promise.reject(new TypeError("sensitive upstream message")),
        ],
      ]),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await worker.runOnce();

    expect(repository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: event.id }),
      "worker-1",
      "handler_failed:TypeError",
    );
  });

  it("processes one aggregate in sequence while allowing other aggregates in parallel", async () => {
    const first = {
      ...event,
      id: "event-1",
      aggregateSequence: "9007199254740992",
    };
    const second = {
      ...event,
      id: "event-2",
      aggregateSequence: "9007199254740993",
    };
    const independent = {
      ...event,
      id: "event-3",
      aggregateId: "technology",
      aggregateSequence: "1",
    };
    const repository = makeRepository();
    repository.claim.mockResolvedValue([second, independent, first]);
    const completed: string[] = [];
    const handler = vi.fn(async (candidate: OutboxEvent) => {
      await Promise.resolve();
      completed.push(candidate.id);
      return {};
    });
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", handler]]),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await worker.runOnce();

    expect(completed.indexOf("event-1")).toBeLessThan(completed.indexOf("event-2"));
  });

  it("does not process a later aggregate event after its predecessor fails", async () => {
    const first = { ...event, id: "event-1", aggregateSequence: "1" };
    const second = { ...event, id: "event-2", aggregateSequence: "2" };
    const repository = makeRepository();
    repository.claim.mockResolvedValue([second, first]);
    const handler = vi.fn((candidate: OutboxEvent) =>
      candidate.id === first.id
        ? Promise.reject(new Error("failed"))
        : Promise.resolve({}),
    );
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", handler]]),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await worker.runOnce();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(first);
  });

  it("does not invoke a handler for a claim whose database lease already expired", async () => {
    const repository = makeRepository();
    repository.claim.mockResolvedValue([
      {
        ...event,
        leaseExpiresAt: new Date(Date.now() - 1),
      },
    ]);
    const handler = vi.fn(() => Promise.resolve({}));
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", handler]]),
      leaseOwner: "worker-1",
      logger,
      replayFrom,
      repository,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(repository.renewLease).not.toHaveBeenCalled();
    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("retries a transient heartbeat error while the local lease is still valid", async () => {
    vi.useFakeTimers();
    const repository = makeRepository();
    repository.renewLease
      .mockRejectedValueOnce(new Error("temporary connection failure"))
      .mockResolvedValue(true);
    const handled = makeDeferred<Record<string, unknown>>();
    const handler = vi.fn(() => handled.promise);
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", handler]]),
      heartbeatIntervalMilliseconds: 1_000,
      leaseOwner: "worker-1",
      leaseSeconds: 4,
      logger,
      replayFrom,
      repository,
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.renewLease).toHaveBeenCalledTimes(1);
    expect(repository.markDelivered).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.renewLease).toHaveBeenCalledTimes(2);

    handled.resolve({ indexed: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toBe(1);
    expect(repository.markDelivered).toHaveBeenCalledWith(event.id, "worker-1", {
      indexed: true,
    });
  });

  it("does not acknowledge when handler completion races with a rejected renewal", async () => {
    vi.useFakeTimers();
    const repository = makeRepository();
    const renewed = makeDeferred<boolean>();
    repository.renewLease.mockReturnValue(renewed.promise);
    const handled = makeDeferred<Record<string, unknown>>();
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", () => handled.promise]]),
      heartbeatIntervalMilliseconds: 1_000,
      leaseOwner: "worker-1",
      leaseSeconds: 4,
      logger,
      replayFrom,
      repository,
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.renewLease).toHaveBeenCalledOnce();

    handled.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.markDelivered).not.toHaveBeenCalled();

    renewed.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toBe(1);
    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("stops acknowledging after transient renewal errors exhaust the local lease", async () => {
    vi.useFakeTimers();
    const repository = makeRepository();
    repository.renewLease.mockRejectedValue(new Error("database unavailable"));
    const handled = makeDeferred<Record<string, unknown>>();
    const worker = new OutboxWorker({
      batchSize: 20,
      handlers: new Map([["community.created", () => handled.promise]]),
      heartbeatIntervalMilliseconds: 500,
      leaseOwner: "worker-1",
      leaseSeconds: 2,
      logger,
      replayFrom,
      repository,
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(repository.renewLease).toHaveBeenCalled();

    handled.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toBe(1);
    expect(repository.markDelivered).not.toHaveBeenCalled();
  });
});
