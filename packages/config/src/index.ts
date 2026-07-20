import { isIP } from "node:net";

import { z } from "zod";

const NodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const LocalDevelopmentAuthSecret = "yKt8Jue5W_Q24xh6bP9FdM3Rav7CzsNe0GLi1TXUcAo";

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
const BooleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

function isStaticHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      !url.hostname.includes("*") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const StaticHttpOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    isStaticHttpOrigin,
    "must be a canonical http(s) origin without a path, query, fragment, credentials, or wildcard",
  );

const StaticHttpOriginListSchema = z
  .string()
  .transform((value) => parseCommaSeparated(value))
  .pipe(z.array(StaticHttpOriginSchema).min(1).max(20));

function isTrustedProxyAddress(value: string): boolean {
  const [address, prefix, ...remainder] = value.split("/");
  if (!address || remainder.length > 0) {
    return false;
  }
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^(0|[1-9][0-9]{0,2})$/.test(prefix)) {
    return false;
  }
  const prefixLength = Number(prefix);
  return prefixLength > 0 && prefixLength <= (family === 4 ? 32 : 128);
}

const TrustedProxyListSchema = z
  .string()
  .default("")
  .transform((value) => parseCommaSeparated(value))
  .pipe(
    z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine(isTrustedProxyAddress, "must be an exact IP address or bounded CIDR"),
      )
      .max(20),
  );

const OptionalNonEmptyStringSchema = (maximumLength: number) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).max(maximumLength).optional(),
  );

const AuthSecretSchema = z
  .string()
  .min(32, "must contain at least 32 characters")
  .max(512)
  .refine((value) => value.trim() === value, "must not contain outer whitespace")
  .refine(
    (value) => new Set(value).size >= 12,
    "must be a high-entropy secret with at least 12 distinct characters",
  )
  .refine(
    (value) => !/(change.?me|example|placeholder|replace.?me)/i.test(value),
    "must not be a placeholder",
  );

const EmailFromSchema = z
  .string()
  .min(3)
  .max(320)
  .refine((value) => {
    const bracketedMatch = /^[^<>\r\n]{1,100}\s+<([^<>\s]+)>$/.exec(value);
    const address = bracketedMatch?.[1] ?? value;
    return z.email().safeParse(address).success;
  }, "must be an email address or a display name followed by an email address in angle brackets");

const AuthEnvironmentFields = {
  AUTH_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  AUTH_EMAIL_DAILY_GLOBAL_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(10_000),
  AUTH_EMAIL_FROM: z.preprocess(
    (value) => (value === "" ? undefined : value),
    EmailFromSchema.optional(),
  ),
  AUTH_EMAIL_MODE: z.enum(["local-preview", "resend"]).default("local-preview"),
  AUTH_EMAIL_REPLY_TO: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.email().max(320).optional(),
  ),
  AUTH_GOOGLE_CLIENT_ID: OptionalNonEmptyStringSchema(1_024),
  AUTH_GOOGLE_CLIENT_SECRET: OptionalNonEmptyStringSchema(2_048),
  AUTH_SECURE_COOKIES: BooleanStringSchema.default(false),
  AUTH_TRUSTED_ORIGINS: StaticHttpOriginListSchema,
  BETTER_AUTH_SECRET: AuthSecretSchema,
  BETTER_AUTH_URL: StaticHttpOriginSchema,
  RESEND_API_KEY: OptionalNonEmptyStringSchema(2_048),
} satisfies z.ZodRawShape;

type AuthEnvironmentValidationTarget = {
  AUTH_EMAIL_FROM?: string | undefined;
  AUTH_EMAIL_MODE: "local-preview" | "resend";
  AUTH_GOOGLE_CLIENT_ID?: string | undefined;
  AUTH_GOOGLE_CLIENT_SECRET?: string | undefined;
  AUTH_SECURE_COOKIES: boolean;
  AUTH_TRUSTED_ORIGINS: string[];
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  NODE_ENV: z.infer<typeof NodeEnvironmentSchema>;
  RESEND_API_KEY?: string | undefined;
};

function validateAuthEnvironment(
  value: AuthEnvironmentValidationTarget,
  context: z.RefinementCtx,
): void {
  const baseUrl = new URL(value.BETTER_AUTH_URL);
  const googleConfigurationCount = [
    value.AUTH_GOOGLE_CLIENT_ID,
    value.AUTH_GOOGLE_CLIENT_SECRET,
  ].filter(Boolean).length;

  if (googleConfigurationCount === 1) {
    context.addIssue({
      code: "custom",
      message: "AUTH_GOOGLE_CLIENT_ID and AUTH_GOOGLE_CLIENT_SECRET must be set together",
      path: [
        value.AUTH_GOOGLE_CLIENT_ID
          ? "AUTH_GOOGLE_CLIENT_SECRET"
          : "AUTH_GOOGLE_CLIENT_ID",
      ],
    });
  }

  if (new Set(value.AUTH_TRUSTED_ORIGINS).size !== value.AUTH_TRUSTED_ORIGINS.length) {
    context.addIssue({
      code: "custom",
      message: "must not contain duplicate origins",
      path: ["AUTH_TRUSTED_ORIGINS"],
    });
  }

  if (value.AUTH_EMAIL_MODE === "resend") {
    if (!value.RESEND_API_KEY) {
      context.addIssue({
        code: "custom",
        message: "is required when AUTH_EMAIL_MODE=resend",
        path: ["RESEND_API_KEY"],
      });
    }
    if (!value.AUTH_EMAIL_FROM) {
      context.addIssue({
        code: "custom",
        message: "is required when AUTH_EMAIL_MODE=resend",
        path: ["AUTH_EMAIL_FROM"],
      });
    }
  }

  if (
    value.AUTH_EMAIL_MODE === "local-preview" &&
    (value.NODE_ENV === "production" || !isLoopbackOrigin(value.BETTER_AUTH_URL))
  ) {
    context.addIssue({
      code: "custom",
      message:
        "local-preview delivery is allowed only outside production with a loopback BETTER_AUTH_URL",
      path: ["AUTH_EMAIL_MODE"],
    });
  }

  if (value.AUTH_SECURE_COOKIES && baseUrl.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "secure cookies require an https BETTER_AUTH_URL",
      path: ["AUTH_SECURE_COOKIES"],
    });
  }

  if (value.NODE_ENV === "production") {
    if (baseUrl.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "must use https in production",
        path: ["BETTER_AUTH_URL"],
      });
    }
    if (!value.AUTH_SECURE_COOKIES) {
      context.addIssue({
        code: "custom",
        message: "must be true in production",
        path: ["AUTH_SECURE_COOKIES"],
      });
    }
    if (value.BETTER_AUTH_SECRET === LocalDevelopmentAuthSecret) {
      context.addIssue({
        code: "custom",
        message: "must not use the repository local-development secret in production",
        path: ["BETTER_AUTH_SECRET"],
      });
    }
    if (value.AUTH_TRUSTED_ORIGINS.some((origin) => !origin.startsWith("https://"))) {
      context.addIssue({
        code: "custom",
        message: "every trusted origin must use https in production",
        path: ["AUTH_TRUSTED_ORIGINS"],
      });
    }
    if (!value.AUTH_TRUSTED_ORIGINS.includes(value.BETTER_AUTH_URL)) {
      context.addIssue({
        code: "custom",
        message:
          "must include BETTER_AUTH_URL in production so Web and Auth share the public cookie origin",
        path: ["AUTH_TRUSTED_ORIGINS"],
      });
    }
  }
}

const AuthEnvironmentBaseSchema = z
  .object({
    NODE_ENV: NodeEnvironmentSchema.default("development"),
    ...AuthEnvironmentFields,
  })
  .superRefine(validateAuthEnvironment);

export const AuthEnvironmentSchema = AuthEnvironmentBaseSchema;
export type AuthEnvironment = z.infer<typeof AuthEnvironmentSchema>;

export const ApiEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  ...AuthEnvironmentFields,
  API_TRUSTED_PROXY_CIDRS: TrustedProxyListSchema,
  PORT: PortSchema.default(4000),
  DATABASE_URL: UrlSchema,
  REDIS_URL: UrlSchema,
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
}).superRefine((value, context) => {
  validateAuthEnvironment(value, context);

  const corsOrigins = parseCommaSeparated(value.CORS_ORIGINS);
  const invalidCorsOrigin = corsOrigins.find((origin) => !isStaticHttpOrigin(origin));
  if (invalidCorsOrigin) {
    context.addIssue({
      code: "custom",
      message:
        "must contain only canonical http(s) origins without paths, credentials, or wildcards",
      path: ["CORS_ORIGINS"],
    });
  }

  const corsOriginSet = new Set(corsOrigins);
  if (value.AUTH_TRUSTED_ORIGINS.some((origin) => !corsOriginSet.has(origin))) {
    context.addIssue({
      code: "custom",
      message: "must include every AUTH_TRUSTED_ORIGINS entry",
      path: ["CORS_ORIGINS"],
    });
  }

  if (value.NODE_ENV === "production" && value.API_TRUSTED_PROXY_CIDRS.length < 1) {
    context.addIssue({
      code: "custom",
      message:
        "must name at least one trusted ingress IP or CIDR in production so auth limits use the client address",
      path: ["API_TRUSTED_PROXY_CIDRS"],
    });
  }
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

export const loadAuthEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  parseEnvironment(AuthEnvironmentSchema, input);

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
