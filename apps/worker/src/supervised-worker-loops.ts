import { setTimeout as delay } from "node:timers/promises";

export interface SupervisedWorkerLoop {
  readonly name: string;
  runOnce(signal: AbortSignal): Promise<number>;
}

export interface SupervisedWorkerLoopsOptions {
  readonly abortController: AbortController;
  readonly loops: readonly SupervisedWorkerLoop[];
  readonly pollIntervalMilliseconds: number;
  readonly runOnce: boolean;
}

/**
 * Runs independent worker queues under one failure boundary. A slow queue does
 * not delay its siblings; if any queue fails, all siblings are stopped and
 * awaited before the original failure is rethrown.
 */
export async function runSupervisedWorkerLoops(
  options: SupervisedWorkerLoopsOptions,
): Promise<void> {
  if (
    options.loops.length < 1 ||
    new Set(options.loops.map((loop) => loop.name)).size !== options.loops.length ||
    options.loops.some(
      (loop) =>
        !/^[a-z][a-z0-9_-]{0,63}$/u.test(loop.name) || typeof loop.runOnce !== "function",
    )
  ) {
    throw new TypeError("Supervised worker loops require unique, valid loop names.");
  }
  if (
    !Number.isSafeInteger(options.pollIntervalMilliseconds) ||
    options.pollIntervalMilliseconds < 1 ||
    options.pollIntervalMilliseconds > 60_000
  ) {
    throw new RangeError("Worker poll intervals must be from 1 through 60000 ms.");
  }

  const signal = options.abortController.signal;
  let hasFailure = false;
  let primaryFailure: unknown;

  const runLoop = async (loop: SupervisedWorkerLoop): Promise<void> => {
    while (!signal.aborted) {
      const processed = await loop.runOnce(signal);
      if (
        !Number.isSafeInteger(processed) ||
        processed < 0 ||
        processed > Number.MAX_SAFE_INTEGER
      ) {
        throw new TypeError(`${loop.name} worker loop returned an invalid work count.`);
      }
      if (options.runOnce || signal.aborted) return;
      if (processed === 0) {
        try {
          await delay(options.pollIntervalMilliseconds, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  };

  const tasks = options.loops.map(async (loop) => {
    try {
      await runLoop(loop);
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true;
        primaryFailure = error;
      }
      options.abortController.abort(error);
    }
  });

  await Promise.all(tasks);
  if (hasFailure) throw primaryFailure;
}
