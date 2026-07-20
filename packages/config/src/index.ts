import { z } from "zod";

const NodeEnvironmentSchema = z.enum(["development", "test", "production"]);

const CommonServiceEnvironmentSchema = z.object({
  NODE_ENV: NodeEnvironmentSchema.default("development"),
  APP_VERSION: z.string().min(1).default("0.1.0"),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

const PortSchema = z.coerce.number().int().min(1).max(65_535);
const UrlSchema = z.url();

export const ApiEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  PORT: PortSchema.default(4000),
  DATABASE_URL: UrlSchema,
  REDIS_URL: UrlSchema,
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
});
export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;

export const McpEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  PORT: PortSchema.default(4100),
  DATABASE_URL: UrlSchema,
  REDIS_URL: UrlSchema,
  MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1,mcp"),
});
export type McpEnvironment = z.infer<typeof McpEnvironmentSchema>;

export const WorkerEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  DATABASE_URL: UrlSchema,
  OUTBOX_CONSUMER_NAME: z
    .string()
    .min(4)
    .max(120)
    .regex(
      /^[a-z0-9][a-z0-9._-]*:v[1-9][0-9]*$/,
      "must end in an explicit positive version such as :v1",
    ),
  OUTBOX_REPLAY_FROM: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  RUN_ONCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export type WorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema>;

export class EnvironmentValidationError extends Error {
  readonly issues: string[];

  constructor(issues: z.core.$ZodIssue[]) {
    const safeIssues = issues.map((issue) => {
      const path = issue.path.join(".") || "environment";
      return `${path}: ${issue.message}`;
    });
    super(`Invalid service configuration: ${safeIssues.join("; ")}`);
    this.name = "EnvironmentValidationError";
    this.issues = safeIssues;
  }
}

function parseEnvironment<T>(
  schema: z.ZodType<T>,
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }
  return result.data;
}

export const loadApiEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  parseEnvironment(ApiEnvironmentSchema, input);

export const loadMcpEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  parseEnvironment(McpEnvironmentSchema, input);

export const loadWorkerEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  parseEnvironment(WorkerEnvironmentSchema, input);

export function parseCorsOrigins(value: string): string[] {
  return parseCommaSeparated(value);
}

export function parseCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
