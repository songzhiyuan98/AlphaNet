import { describe, expect, it, vi } from "vitest";

import {
  runSupervisedWorkerLoops,
  type SupervisedWorkerLoop,
} from "./supervised-worker-loops.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

describe("runSupervisedWorkerLoops", () => {
  it("keeps the core queue progressing while Search work is still running", async () => {
    const abortController = new AbortController();
    let coreRuns = 0;
    const runCoreOnce = vi.fn<SupervisedWorkerLoop["runOnce"]>(() => {
      coreRuns += 1;
      if (coreRuns === 3) abortController.abort();
      return Promise.resolve(1);
    });
    const runSearchOnce = vi.fn<SupervisedWorkerLoop["runOnce"]>(async (signal) => {
      await waitForAbort(signal);
      return 0;
    });
    const core: SupervisedWorkerLoop = {
      name: "core",
      runOnce: runCoreOnce,
    };
    const search: SupervisedWorkerLoop = {
      name: "search-index",
      runOnce: runSearchOnce,
    };

    await expect(
      runSupervisedWorkerLoops({
        abortController,
        loops: [core, search],
        pollIntervalMilliseconds: 1_000,
        runOnce: false,
      }),
    ).resolves.toBeUndefined();

    expect(runCoreOnce).toHaveBeenCalledTimes(3);
    expect(runSearchOnce).toHaveBeenCalledOnce();
  });

  it("aborts and awaits sibling queues before surfacing the first failure", async () => {
    const abortController = new AbortController();
    const failure = new Error("Search index storage failed");
    let siblingStopped = false;
    const runCoreOnce = vi.fn<SupervisedWorkerLoop["runOnce"]>(async (signal) => {
      await waitForAbort(signal);
      siblingStopped = true;
      return 0;
    });
    const runSearchOnce = vi.fn<SupervisedWorkerLoop["runOnce"]>(() =>
      Promise.reject(failure),
    );
    const core: SupervisedWorkerLoop = {
      name: "core",
      runOnce: runCoreOnce,
    };
    const search: SupervisedWorkerLoop = {
      name: "search-index",
      runOnce: runSearchOnce,
    };

    await expect(
      runSupervisedWorkerLoops({
        abortController,
        loops: [core, search],
        pollIntervalMilliseconds: 1_000,
        runOnce: false,
      }),
    ).rejects.toBe(failure);

    expect(abortController.signal.aborted).toBe(true);
    expect(siblingStopped).toBe(true);
  });

  it("runs every queue exactly once in RUN_ONCE mode", async () => {
    const abortController = new AbortController();
    const core = vi.fn(() => Promise.resolve(4));
    const search = vi.fn(() => Promise.resolve(2));

    await runSupervisedWorkerLoops({
      abortController,
      loops: [
        { name: "core", runOnce: core },
        { name: "search-index", runOnce: search },
      ],
      pollIntervalMilliseconds: 1_000,
      runOnce: true,
    });

    expect(core).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(abortController.signal.aborted).toBe(false);
  });

  it("rejects invalid loop configuration before starting work", async () => {
    const abortController = new AbortController();
    const runOnce = vi.fn(() => Promise.resolve(0));

    await expect(
      runSupervisedWorkerLoops({
        abortController,
        loops: [
          { name: "duplicate", runOnce },
          { name: "duplicate", runOnce },
        ],
        pollIntervalMilliseconds: 1_000,
        runOnce: false,
      }),
    ).rejects.toThrow("unique, valid loop names");
    expect(runOnce).not.toHaveBeenCalled();
  });
});
