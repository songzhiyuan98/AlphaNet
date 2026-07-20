import type { OutboxEvent } from "@alphanet/database";
import type { Logger } from "pino";

export interface WorkerRepository {
  claim(options: {
    batchSize: number;
    eventTypes?: readonly string[];
    leaseOwner: string;
    leaseSeconds?: number;
    replayFrom: Date;
  }): Promise<OutboxEvent[]>;
  renewLease(
    eventId: string,
    leaseOwner: string,
    leaseSeconds?: number,
  ): Promise<boolean>;
  markDelivered(
    eventId: string,
    leaseOwner: string,
    result?: Record<string, unknown>,
  ): Promise<boolean>;
  markFailed(event: OutboxEvent, leaseOwner: string, errorCode: string): Promise<boolean>;
}

export type OutboxHandler = (
  event: OutboxEvent,
) => Promise<Record<string, unknown> | undefined>;

export interface OutboxWorkerOptions {
  batchSize: number;
  heartbeatIntervalMilliseconds?: number;
  handlers: ReadonlyMap<string, OutboxHandler>;
  leaseSeconds?: number;
  leaseOwner: string;
  logger: Logger;
  replayFrom: Date;
  repository: WorkerRepository;
}

export class OutboxWorker {
  constructor(private readonly options: OutboxWorkerOptions) {}

  async runOnce(): Promise<number> {
    const eventTypes = [...this.options.handlers.keys()];
    if (eventTypes.length === 0) {
      return 0;
    }
    const leaseSeconds = this.options.leaseSeconds ?? 30;
    const events = await this.options.repository.claim({
      batchSize: this.options.batchSize,
      eventTypes,
      leaseOwner: this.options.leaseOwner,
      leaseSeconds,
      replayFrom: this.options.replayFrom,
    });

    const aggregateGroups = new Map<string, OutboxEvent[]>();
    for (const event of events) {
      const key = `${event.aggregateType.length}:${event.aggregateType}${event.aggregateId}`;
      const group = aggregateGroups.get(key) ?? [];
      group.push(event);
      aggregateGroups.set(key, group);
    }

    await Promise.all(
      [...aggregateGroups.values()].map(async (group) => {
        group.sort((left, right) => {
          const leftSequence = BigInt(left.aggregateSequence);
          const rightSequence = BigInt(right.aggregateSequence);
          return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
        });
        for (const event of group) {
          const delivered = await this.process(event, leaseSeconds);
          if (!delivered) {
            break;
          }
        }
      }),
    );
    return events.length;
  }

  private async process(event: OutboxEvent, leaseSeconds: number): Promise<boolean> {
    const claimedLeaseDeadline = event.leaseExpiresAt.getTime();
    if (!Number.isFinite(claimedLeaseDeadline) || claimedLeaseDeadline <= Date.now()) {
      this.options.logger.warn(
        { eventId: event.id },
        "outbox claim reached the worker after its database lease expired",
      );
      return false;
    }

    const handler = this.options.handlers.get(event.eventType);
    if (!handler) {
      this.options.logger.warn(
        { eventId: event.id, eventType: event.eventType },
        "outbox event has no registered handler",
      );
      const released = await this.options.repository.markFailed(
        event,
        this.options.leaseOwner,
        "handler_not_registered",
      );
      if (!released) {
        this.options.logger.warn(
          { eventId: event.id },
          "outbox lease was lost before missing-handler acknowledgement",
        );
      }
      return false;
    }

    const heartbeatIntervalMilliseconds =
      this.options.heartbeatIntervalMilliseconds ?? Math.max(1_000, leaseSeconds * 333);
    const leaseMilliseconds = leaseSeconds * 1_000;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatStopped = false;
    let leaseLost = false;
    let localLeaseDeadline = claimedLeaseDeadline;
    let renewal = Promise.resolve();
    const markLeaseLost = (message: string) => {
      if (leaseLost) {
        return;
      }
      leaseLost = true;
      this.options.logger.warn({ eventId: event.id }, message);
    };
    const scheduleHeartbeat = () => {
      if (heartbeatStopped || leaseLost) {
        return;
      }
      const remainingMilliseconds = localLeaseDeadline - Date.now();
      if (remainingMilliseconds <= 0) {
        markLeaseLost("outbox lease expired before it could be renewed");
        return;
      }
      const nextHeartbeatMilliseconds = Math.min(
        heartbeatIntervalMilliseconds,
        Math.max(1, Math.floor(remainingMilliseconds / 2)),
      );
      heartbeat = setTimeout(() => {
        heartbeat = undefined;
        if (heartbeatStopped || leaseLost) {
          return;
        }
        if (Date.now() >= localLeaseDeadline) {
          markLeaseLost("outbox lease expired before it could be renewed");
          return;
        }

        const renewalStartedAt = Date.now();
        renewal = this.options.repository
          .renewLease(event.id, this.options.leaseOwner, leaseSeconds)
          .then((renewed) => {
            if (!renewed) {
              markLeaseLost("outbox lease renewal was rejected");
              return;
            }
            localLeaseDeadline = renewalStartedAt + leaseMilliseconds;
            if (!heartbeatStopped) {
              scheduleHeartbeat();
            }
          })
          .catch((error: unknown) => {
            this.options.logger.warn(
              { err: error, eventId: event.id },
              "outbox lease renewal failed before the local lease deadline; retrying",
            );
            if (Date.now() >= localLeaseDeadline) {
              markLeaseLost("outbox lease expired after renewal failures");
              return;
            }
            if (!heartbeatStopped) {
              scheduleHeartbeat();
            }
          });
      }, nextHeartbeatMilliseconds);
    };
    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      if (heartbeat) {
        clearTimeout(heartbeat);
        heartbeat = undefined;
      }
      await renewal;
      if (!leaseLost && Date.now() >= localLeaseDeadline) {
        markLeaseLost("outbox lease expired before handler completion");
      }
    };
    scheduleHeartbeat();

    try {
      const result = (await handler(event)) ?? {};
      await stopHeartbeat();
      if (leaseLost) {
        return false;
      }
      const delivered = await this.options.repository.markDelivered(
        event.id,
        this.options.leaseOwner,
        result,
      );
      if (!delivered) {
        this.options.logger.warn(
          { eventId: event.id },
          "outbox lease was lost before delivery acknowledgement",
        );
      }
      return delivered;
    } catch (error) {
      await stopHeartbeat();
      this.options.logger.error(
        { err: error, eventId: event.id, eventType: event.eventType },
        "outbox handler failed",
      );
      if (leaseLost) {
        return false;
      }
      const errorCode =
        error instanceof Error
          ? `handler_failed:${error.name}`
          : "handler_failed:unknown";
      const released = await this.options.repository.markFailed(
        event,
        this.options.leaseOwner,
        errorCode,
      );
      if (!released) {
        this.options.logger.warn(
          { eventId: event.id },
          "outbox lease was lost before failure acknowledgement",
        );
      }
      return false;
    } finally {
      if (heartbeat) {
        clearTimeout(heartbeat);
        heartbeat = undefined;
      }
    }
  }
}
