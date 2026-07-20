import { Redis } from "ioredis";
import postgres from "postgres";

export * from "./outbox.js";

export interface HealthDependency {
  readonly name: string;
  readonly critical?: boolean;
  check(): Promise<void>;
  close(): Promise<void>;
}

export type PostgresClient = ReturnType<typeof postgres>;

export interface PostgresDependency extends HealthDependency {
  readonly sql: PostgresClient;
}

export interface RedisDependency extends HealthDependency {
  readonly client: Redis;
}

export interface RedisDependencyOptions {
  critical?: boolean;
}

export function createPostgresDependency(connectionUrl: string): PostgresDependency {
  const sql = postgres(connectionUrl, {
    connect_timeout: 5,
    idle_timeout: 20,
    max: 10,
    onnotice: () => undefined,
  });
  // Keep probe limits independent from application-query policy. The outer
  // readiness deadline returns promptly, while these driver limits also bound
  // the underlying connection/query instead of leaving it running indefinitely.
  const healthSql = postgres(connectionUrl, {
    connect_timeout: 2,
    connection: {
      statement_timeout: 1_500,
    },
    idle_timeout: 10,
    max: 1,
    onnotice: () => undefined,
  });

  return {
    critical: true,
    name: "postgres",
    sql,
    async check() {
      await healthSql`select 1`;
    },
    async close() {
      await Promise.all([sql.end({ timeout: 5 }), healthSql.end({ timeout: 5 })]);
    },
  };
}

export function createRedisDependency(
  connectionUrl: string,
  options: RedisDependencyOptions = {},
): RedisDependency {
  const client = new Redis(connectionUrl, {
    commandTimeout: 1_500,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  client.on("error", () => {
    // Callers log failed probes; an error listener prevents an unhandled event.
  });

  return {
    critical: options.critical ?? false,
    name: "redis",
    client,
    async check() {
      if (client.status === "wait") {
        await client.connect();
      }
      await client.ping();
    },
    async close() {
      if (client.status === "ready") {
        await client.quit();
        return;
      }
      client.disconnect();
    },
  };
}

export async function closeDependencies(
  dependencies: readonly HealthDependency[],
): Promise<void> {
  await Promise.allSettled(dependencies.map(async (dependency) => dependency.close()));
}
