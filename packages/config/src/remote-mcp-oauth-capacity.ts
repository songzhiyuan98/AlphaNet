const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * One capacity contract shared by OAuth admission and lifecycle maintenance.
 *
 * An accepted authorize request can create at most one persisted authorization
 * envelope and, later, at most one Grant bootstrap. A single Worker therefore
 * has a configured row budget above the global admission ceiling for every
 * maintenance stage. Keep the strict inequality: equality cannot absorb a
 * backlog that accumulated while a Worker was restarting.
 */
export const REMOTE_MCP_OAUTH_CAPACITY_POLICY = Object.freeze({
  authorize: Object.freeze({
    client: Object.freeze({ max: 300, window: 60 }),
    global: Object.freeze({ max: 1_200, window: 60 }),
    ip: Object.freeze({ max: 60, window: 60 }),
  }),
  lifecycle: Object.freeze({
    backlogAlarmThreshold: 1_200,
    backlogObservationCap: 10_000,
    batchSize: 250,
    failureRetryMilliseconds: 5_000,
    intervalMilliseconds: 30_000,
    maximumRowsPerStage: 1_000,
    maximumRunMilliseconds: 25_000,
  }),
});

export function remoteMcpOAuthRowsPerMinute(
  maximumRows: number,
  intervalMilliseconds: number,
): number {
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    !Number.isSafeInteger(intervalMilliseconds) ||
    intervalMilliseconds < 1
  ) {
    throw new RangeError("Remote MCP OAuth capacity inputs must be positive integers.");
  }
  return Math.floor((maximumRows * ONE_MINUTE_MILLISECONDS) / intervalMilliseconds);
}

export const REMOTE_MCP_OAUTH_AUTHORIZE_GLOBAL_CEILING_PER_MINUTE =
  remoteMcpOAuthRowsPerMinute(
    REMOTE_MCP_OAUTH_CAPACITY_POLICY.authorize.global.max,
    REMOTE_MCP_OAUTH_CAPACITY_POLICY.authorize.global.window * 1_000,
  );

export const REMOTE_MCP_OAUTH_LIFECYCLE_SINGLE_WORKER_ROWS_PER_MINUTE =
  remoteMcpOAuthRowsPerMinute(
    REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.maximumRowsPerStage,
    REMOTE_MCP_OAUTH_CAPACITY_POLICY.lifecycle.intervalMilliseconds,
  );

if (
  REMOTE_MCP_OAUTH_LIFECYCLE_SINGLE_WORKER_ROWS_PER_MINUTE <=
  REMOTE_MCP_OAUTH_AUTHORIZE_GLOBAL_CEILING_PER_MINUTE
) {
  throw new Error(
    "Remote MCP OAuth lifecycle capacity must exceed the authorize admission ceiling.",
  );
}
