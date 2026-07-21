import {
  ApprovedResearchExecutionError,
  type PendingActionCommittedState,
  type PendingActionExecutionClaim,
} from "@alphanet/domain";
import { createLogger } from "@alphanet/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PendingActionWorker,
  type ApprovedResearchExecutor,
  type PendingActionWorkerRepository,
} from "./pending-action-worker.js";

const actionId = "00000000-0000-4000-8000-000000000001";
const claim: PendingActionExecutionClaim = {
  actionId,
  attemptCount: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  leaseOwner: "worker-test",
  leaseToken: Buffer.alloc(32, 7),
  operation: "create_post",
  version: "3",
};
const logger = createLogger({
  environment: "test",
  level: "silent",
  service: "pending-action-worker-test",
});

function committed(
  state: PendingActionCommittedState["state"],
): PendingActionCommittedState {
  return {
    actionId,
    attemptCount: 1,
    error: null,
    failureCount: 0,
    idempotencyResponse: {},
    idempotencyStatus:
      state === "succeeded"
        ? "succeeded"
        : state === "rejected" || state === "expired" || state === "cancelled"
          ? "denied"
          : state === "failed" || state === "invalidated"
            ? "failed"
            : "pending_approval",
    operation: "create_post",
    resourceId: state === "succeeded" ? "00000000-0000-4000-8000-000000000002" : null,
    result: null,
    state,
    terminalAt:
      state === "succeeded" ||
      state === "rejected" ||
      state === "expired" ||
      state === "cancelled" ||
      state === "failed" ||
      state === "invalidated"
        ? new Date()
        : null,
    version: "4",
  };
}

function repository(): PendingActionWorkerRepository & {
  claimBatch: ReturnType<typeof vi.fn>;
  markInvalidated: ReturnType<typeof vi.fn>;
  readCommittedState: ReturnType<typeof vi.fn>;
  reap: ReturnType<typeof vi.fn>;
  renewHeartbeat: ReturnType<typeof vi.fn>;
  scheduleRetry: ReturnType<typeof vi.fn>;
} {
  return {
    claimBatch: vi.fn(() => Promise.resolve([claim])),
    finalizeSucceeded: vi.fn(() =>
      Promise.reject(new Error("not used by the executor mock")),
    ),
    markInvalidated: vi.fn(() =>
      Promise.resolve({ action: committed("invalidated"), applied: true }),
    ),
    readCommittedState: vi.fn(() => Promise.resolve(committed("executing"))),
    reap: vi.fn(() =>
      Promise.resolve({
        expired: 0,
        failed: 0,
        processed: 0,
        recovered: 0,
      }),
    ),
    renewHeartbeat: vi.fn(() =>
      Promise.resolve({
        action: null,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        renewed: true,
        version: "4",
      }),
    ),
    scheduleRetry: vi.fn(() =>
      Promise.resolve({ action: committed("approved"), applied: true }),
    ),
    withFencedClaim: vi.fn(() =>
      Promise.reject(new Error("not used by the executor mock")),
    ),
  };
}

function executor(
  implementation: ApprovedResearchExecutor["executeApprovedAction"] = () =>
    Promise.resolve({
      action: committed("succeeded"),
      content: {
        contentId: "00000000-0000-4000-8000-000000000002",
        resourceVersion: 1,
        revisionId: "00000000-0000-4000-8000-000000000003",
      },
      resolvedOutboxEventId: "00000000-0000-4000-8000-000000000004",
    }),
): ApprovedResearchExecutor & {
  executeApprovedAction: ReturnType<typeof vi.fn>;
} {
  return { executeApprovedAction: vi.fn(implementation) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PendingActionWorker", () => {
  it("reaps, claims and executes a bounded batch", async () => {
    const store = repository();
    store.reap.mockResolvedValue({
      expired: 1,
      failed: 0,
      processed: 1,
      recovered: 0,
    });
    const writer = executor();
    const beforeClaim = vi.fn(() => Promise.resolve());
    const worker = new PendingActionWorker({
      batchSize: 20,
      beforeClaim,
      executor: writer,
      logger,
      repository: store,
    });

    await expect(worker.runOnce()).resolves.toBe(2);
    expect(beforeClaim).toHaveBeenCalledOnce();
    expect(store.reap).toHaveBeenCalledWith(20);
    expect(store.claimBatch).toHaveBeenCalledWith(20);
    expect(writer.executeApprovedAction).toHaveBeenCalledWith(store, claim);
  });

  it("turns a permanent revalidation failure into an invalidated terminal action", async () => {
    const store = repository();
    const writer = executor(() =>
      Promise.reject(
        new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID"),
      ),
    );
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      logger,
      repository: store,
    });

    await worker.runOnce();

    expect(store.markInvalidated).toHaveBeenCalledExactlyOnceWith(claim);
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it("persists a not-before retry for a live rate limit", async () => {
    const store = repository();
    const writer = executor(() =>
      Promise.reject(
        new ApprovedResearchExecutionError("APPROVED_ACTION_RATE_LIMITED", {
          retryAfterMs: 90_001,
        }),
      ),
    );
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      logger,
      repository: store,
    });

    await worker.runOnce();

    expect(store.scheduleRetry).toHaveBeenCalledExactlyOnceWith(claim, {
      budgetDisposition: "defer",
      maximumDelaySeconds: 91,
      minimumDelaySeconds: 91,
    });
    expect(store.markInvalidated).not.toHaveBeenCalled();
  });

  it("leaves transition-write failures for lease recovery without crashing the batch", async () => {
    const store = repository();
    store.markInvalidated.mockRejectedValue(new Error("database unavailable"));
    const writer = executor(() =>
      Promise.reject(
        new ApprovedResearchExecutionError("APPROVED_ACTION_CONTEXT_INVALID"),
      ),
    );
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      logger,
      repository: store,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
  });

  it("rereads durable state after an ambiguous success response", async () => {
    const store = repository();
    store.readCommittedState.mockResolvedValue(committed("succeeded"));
    const writer = executor(() =>
      Promise.reject(new Error("connection ended after commit")),
    );
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      logger,
      repository: store,
    });

    await worker.runOnce();

    expect(store.readCommittedState).toHaveBeenCalledWith(actionId);
    expect(store.scheduleRetry).not.toHaveBeenCalled();
  });

  it("schedules a retry only when an unexpected failure is not terminal", async () => {
    const store = repository();
    store.readCommittedState.mockResolvedValue(committed("executing"));
    const writer = executor(() => Promise.reject(new TypeError("driver failed")));
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      logger,
      repository: store,
    });

    await worker.runOnce();

    expect(store.scheduleRetry).toHaveBeenCalledExactlyOnceWith(claim);
  });

  it("renews a long execution lease and does not mutate state after success", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const liveClaim = {
      ...claim,
      leaseExpiresAt: new Date(Date.now() + 1_000),
    };
    const store = repository();
    store.claimBatch.mockResolvedValue([liveClaim]);
    const writer = executor(async () => {
      await pending;
      return {
        action: committed("succeeded"),
        content: {
          contentId: "00000000-0000-4000-8000-000000000002",
          resourceVersion: 1,
          revisionId: "00000000-0000-4000-8000-000000000003",
        },
        resolvedOutboxEventId: "00000000-0000-4000-8000-000000000004",
      };
    });
    const worker = new PendingActionWorker({
      batchSize: 1,
      executor: writer,
      heartbeatIntervalMilliseconds: 100,
      logger,
      repository: store,
    });

    const run = worker.runOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.renewHeartbeat).toHaveBeenCalledWith(liveClaim);
    complete();
    await run;

    expect(store.scheduleRetry).not.toHaveBeenCalled();
    expect(store.markInvalidated).not.toHaveBeenCalled();
  });
});
