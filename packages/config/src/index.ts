import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";

import { z } from "zod";

const NodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const LocalDevelopmentAuthSecret = "yKt8Jue5W_Q24xh6bP9FdM3Rav7CzsNe0GLi1TXUcAo";
const LocalDevelopmentAgentApiKeyPepper = "h9mP6Lrz3dF5cQ8K7Vw2uX4aN1sJ0tYbEoGkUiZp";
const LocalDevelopmentPendingActionEncryptionKey =
  "8f7d9c1e0b2a4d6f91c3e5a7b9d1f20436587a9cbed0f123456789abcdef0123";
const LocalDevelopmentCommunityCursorSigningKey =
  "C4p8Vw2nR7xL9mQ3sT6yH1kD5fJ0aB8uE2zN7gS4";
const LocalDevelopmentSsrInternalRequestSecret =
  "L8wq2Uox9sV7Gm1Xc4Kd6aJ0Ph5Rt3NyE1bZfQ7i";
const TitanTextEmbedV2ModelId = "amazon.titan-embed-text-v2:0";
const SearchIndexDatabaseMarginMilliseconds = 5_000;
const RemoteMcpInternalApiDefaultPort = 4_443;
const RemoteMcpInternalApiDefaultTimeoutMilliseconds = 5_000;
const RemoteMcpInternalApiDefaultMaximumResponseBytes = 4 * 1_024 * 1_024;

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

const AdminOidcSigningAlgorithmSchema = z.enum([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

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

const AdminOidcAlgorithmsSchema = z
  .string()
  .default("RS256")
  .transform((value) => parseCommaSeparated(value))
  .pipe(
    z
      .array(AdminOidcSigningAlgorithmSchema)
      .min(1)
      .max(10)
      .refine((value) => new Set(value).size === value.length, {
        message: "must not contain duplicate signing algorithms",
      }),
  );

const AdminOidcAcrValuesSchema = z
  .string()
  .default("")
  .transform((value) => parseCommaSeparated(value))
  .pipe(
    z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII without spaces"),
      )
      .max(20)
      .refine((value) => new Set(value).size === value.length, {
        message: "must not contain duplicate acr values",
      }),
  );

const AdminOidcAudienceSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "must contain only visible ASCII without spaces");

function isCanonicalOidcUrl(value: string, kind: "issuer" | "jwks"): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (kind !== "issuer" || url.search === "") &&
      (url.protocol === "https:" || isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

const AdminOidcIssuerSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => isCanonicalOidcUrl(value, "issuer"),
    "must be an https OIDC issuer URL (or loopback http URL) without credentials, query, or fragment",
  );

const AdminOidcJwksUriSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => isCanonicalOidcUrl(value, "jwks"),
    "must be an https JWKS URL (or loopback http URL) without credentials or fragment",
  );

const OptionalAdminOidcIssuerSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  AdminOidcIssuerSchema.optional(),
);
const OptionalAdminOidcJwksUriSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  AdminOidcJwksUriSchema.optional(),
);
const OptionalAdminOidcAudienceSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  AdminOidcAudienceSchema.optional(),
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

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (
    value.length < 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function canonicalBase64BytesSchema(
  minimumBytes: number,
  maximumBytes: number,
  description: string,
) {
  return z
    .string()
    .min(1)
    .max(Math.ceil((maximumBytes * 4) / 3) + 4)
    .transform((value, context) => {
      const decoded = decodeCanonicalBase64(value);
      if (
        decoded === undefined ||
        decoded.byteLength < minimumBytes ||
        decoded.byteLength > maximumBytes
      ) {
        context.addIssue({
          code: "custom",
          message: `must be canonical base64 containing ${description}`,
        });
        return z.NEVER;
      }
      return decoded;
    });
}

const McpIndependentKeyBase64Schema = canonicalBase64BytesSchema(
  32,
  32,
  "exactly 32 random bytes",
).refine((value) => new Set(value).size >= 12, {
  message: "must contain high-entropy independent key material",
});

function parseCertificateBundle(value: Buffer): X509Certificate[] {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) {
    throw new TypeError("certificate PEM must be valid UTF-8");
  }
  const certificates: X509Certificate[] = [];
  const certificatePattern =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let consumedUntil = 0;
  for (const match of text.matchAll(certificatePattern)) {
    const index = match.index;
    const pem = match[0];
    if (index === undefined || !/^\s*$/.test(text.slice(consumedUntil, index))) {
      throw new TypeError("certificate PEM bundle contains non-certificate data");
    }
    certificates.push(new X509Certificate(pem));
    consumedUntil = index + pem.length;
  }
  if (
    certificates.length < 1 ||
    certificates.length > 10 ||
    !/^\s*$/.test(text.slice(consumedUntil))
  ) {
    throw new TypeError("certificate PEM bundle must contain one to ten certificates");
  }
  return certificates;
}

const McpCertificatePemBase64Schema = canonicalBase64BytesSchema(
  1,
  256 * 1_024,
  "a PEM certificate bundle no larger than 256 KiB",
).transform((value, context) => {
  try {
    parseCertificateBundle(value);
    return value;
  } catch {
    context.addIssue({
      code: "custom",
      message: "must decode to a valid PEM certificate bundle",
    });
    return z.NEVER;
  }
});

const McpPrivateKeyPemBase64Schema = canonicalBase64BytesSchema(
  1,
  64 * 1_024,
  "an unencrypted PEM private key no larger than 64 KiB",
).transform((value, context) => {
  try {
    createPrivateKey(value);
    return value;
  } catch {
    context.addIssue({
      code: "custom",
      message: "must decode to a valid unencrypted PEM private key",
    });
    return z.NEVER;
  }
});

const OptionalMcpCertificatePemBase64Schema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  McpCertificatePemBase64Schema.optional(),
);
const OptionalMcpPrivateKeyPemBase64Schema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  McpPrivateKeyPemBase64Schema.optional(),
);
const OptionalMcpIndependentKeyBase64Schema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  McpIndependentKeyBase64Schema.optional(),
);

const McpCertificateFingerprintListSchema = z
  .string()
  .default("")
  .transform((value) => parseCommaSeparated(value))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(
            /^[0-9A-F]{64}$/,
            "must be a canonical uppercase SHA-256 fingerprint without separators",
          ),
      )
      .max(3)
      .refine((value) => new Set(value).size === value.length, {
        message: "must not contain duplicate client-certificate fingerprints",
      }),
  );

const OptionalMcpKeyVersionSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(32_767).optional(),
);

const CanonicalUtcInstantSchema = z
  .string()
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
  }, "must be a canonical UTC ISO-8601 instant")
  .transform((value) => new Date(value));

const McpActorPreviousKeyRingSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === "") {
      return {};
    }
    if (typeof value !== "string") {
      return value;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      // Requiring JSON.stringify's compact representation rejects duplicate
      // object keys and ambiguous alternate spellings before key selection.
      return JSON.stringify(parsed) === value ? parsed : value;
    } catch {
      return value;
    }
  },
  z.record(
    z
      .string()
      .regex(/^[1-9][0-9]{0,4}$/, "key versions must be positive integers")
      .refine((value) => Number(value) <= 32_767, "key versions must not exceed 32767"),
    z
      .object({
        keyBase64: McpIndependentKeyBase64Schema,
        verificationExpiresAt: CanonicalUtcInstantSchema,
      })
      .strict(),
  ),
);

const AgentPreviousPepperRingSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === "") {
      return {};
    }
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  z.record(
    z
      .string()
      .regex(/^[1-9][0-9]{0,4}$/, "pepper versions must be positive integers")
      .refine(
        (value) => Number(value) <= 32_767,
        "pepper versions must not exceed 32767",
      ),
    AuthSecretSchema,
  ),
);

const PendingActionEncryptionKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "must be a lower-case hexadecimal encoding of exactly 32 random bytes",
  );

const PendingActionPreviousKeyRingSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === "") {
      return {};
    }
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  z.record(
    z
      .string()
      .regex(/^[1-9][0-9]{0,4}$/, "key versions must be positive integers")
      .refine((value) => Number(value) <= 32_767, "key versions must not exceed 32767"),
    PendingActionEncryptionKeySchema,
  ),
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

const AgentCredentialEnvironmentFields = {
  AGENT_API_AUDIENCE: z.string().min(8).max(200).default("urn:alphanet:api:v1"),
  AGENT_API_KEY_PEPPER: AuthSecretSchema,
  AGENT_API_KEY_PEPPER_VERSION: z.coerce.number().int().min(1).max(32_767).default(1),
  AGENT_API_KEY_PREVIOUS_PEPPERS: AgentPreviousPepperRingSchema,
  AGENT_CREDENTIAL_ACTIVE_PER_AGENT: z.coerce.number().int().min(1).max(100).default(5),
  AGENT_CREDENTIAL_ACTIVE_PER_OWNER: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(20),
  AGENT_CREDENTIAL_DEFAULT_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  AGENT_CREDENTIAL_ISSUE_PER_OWNER_24H: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(10),
  AGENT_CREDENTIAL_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  AGENT_CREDENTIAL_MUTATION_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(30),
} satisfies z.ZodRawShape;

const AdminApiEnvironmentFields = {
  ADMIN_AUDIT_SUBJECT_DIGEST_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    PendingActionEncryptionKeySchema.optional(),
  ),
  ADMIN_API_ENABLED: BooleanStringSchema.default(false),
  ADMIN_OIDC_ALLOWED_ACR_VALUES: AdminOidcAcrValuesSchema,
  ADMIN_OIDC_ALLOWED_ALGORITHMS: AdminOidcAlgorithmsSchema,
  ADMIN_OIDC_ALLOW_AMR_MFA: BooleanStringSchema.default(true),
  ADMIN_OIDC_AUDIENCE: OptionalAdminOidcAudienceSchema,
  ADMIN_OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
  ADMIN_OIDC_ISSUER: OptionalAdminOidcIssuerSchema,
  ADMIN_OIDC_JWKS_URI: OptionalAdminOidcJwksUriSchema,
} satisfies z.ZodRawShape;

const PendingActionCryptoEnvironmentFields = {
  PENDING_ACTION_ENCRYPTION_KEY: PendingActionEncryptionKeySchema.default(
    LocalDevelopmentPendingActionEncryptionKey,
  ),
  PENDING_ACTION_ENCRYPTION_KEY_VERSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(32_767)
    .default(1),
  PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: PendingActionPreviousKeyRingSchema.default({}),
} satisfies z.ZodRawShape;

const SearchEmbeddingEnvironmentFields = {
  SEARCH_EMBEDDING_PROVIDER: z.enum(["disabled", "bedrock"]).default("disabled"),
  SEARCH_EMBEDDING_MODEL_ID: z
    .literal(TitanTextEmbedV2ModelId)
    .default(TitanTextEmbedV2ModelId),
  SEARCH_EMBEDDING_DIMENSIONS: z.coerce.number().pipe(z.literal(512)).default(512),
  SEARCH_EMBEDDING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(30_000)
    .default(5_000),
} satisfies z.ZodRawShape;

type PendingActionCryptoValidationTarget = {
  NODE_ENV: z.infer<typeof NodeEnvironmentSchema>;
  PENDING_ACTION_ENCRYPTION_KEY: string;
  PENDING_ACTION_ENCRYPTION_KEY_VERSION: number;
  PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS: Record<string, string>;
};

function validatePendingActionCryptoEnvironment(
  value: PendingActionCryptoValidationTarget,
  context: z.RefinementCtx,
): void {
  if (
    value.NODE_ENV === "production" &&
    (value.PENDING_ACTION_ENCRYPTION_KEY === LocalDevelopmentPendingActionEncryptionKey ||
      Object.values(value.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).includes(
        LocalDevelopmentPendingActionEncryptionKey,
      ))
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must not use the repository local-development PendingAction key in production",
      path: ["PENDING_ACTION_ENCRYPTION_KEY"],
    });
  }
  if (
    Object.hasOwn(
      value.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS,
      String(value.PENDING_ACTION_ENCRYPTION_KEY_VERSION),
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must not duplicate PENDING_ACTION_ENCRYPTION_KEY_VERSION in the previous key ring",
      path: ["PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS"],
    });
  }
  if (Object.keys(value.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).length > 5) {
    context.addIssue({
      code: "custom",
      message: "must contain at most five previous encryption-key versions",
      path: ["PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS"],
    });
  }
  if (
    new Set([
      value.PENDING_ACTION_ENCRYPTION_KEY,
      ...Object.values(value.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS),
    ]).size !==
    1 + Object.keys(value.PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS).length
  ) {
    context.addIssue({
      code: "custom",
      message: "must not reuse PendingAction key material across versions",
      path: ["PENDING_ACTION_PREVIOUS_ENCRYPTION_KEYS"],
    });
  }
}

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

type AdminApiEnvironmentValidationTarget = {
  ADMIN_AUDIT_SUBJECT_DIGEST_KEY?: string | undefined;
  ADMIN_API_ENABLED: boolean;
  ADMIN_OIDC_ALLOWED_ACR_VALUES: string[];
  ADMIN_OIDC_ALLOW_AMR_MFA: boolean;
  ADMIN_OIDC_AUDIENCE?: string | undefined;
  ADMIN_OIDC_ISSUER?: string | undefined;
  ADMIN_OIDC_JWKS_URI?: string | undefined;
  AGENT_API_KEY_PEPPER: string;
  NODE_ENV: z.infer<typeof NodeEnvironmentSchema>;
  PENDING_ACTION_ENCRYPTION_KEY: string;
};

function validateAdminApiEnvironment(
  value: AdminApiEnvironmentValidationTarget,
  context: z.RefinementCtx,
): void {
  const configuredTuple = [
    value.ADMIN_OIDC_ISSUER,
    value.ADMIN_OIDC_AUDIENCE,
    value.ADMIN_OIDC_JWKS_URI,
  ];
  const configuredCount = configuredTuple.filter(Boolean).length;
  if (configuredCount !== 0 && configuredCount !== configuredTuple.length) {
    context.addIssue({
      code: "custom",
      message:
        "ADMIN_OIDC_ISSUER, ADMIN_OIDC_AUDIENCE, and ADMIN_OIDC_JWKS_URI must be configured together",
      path: ["ADMIN_OIDC_ISSUER"],
    });
  }
  if (value.ADMIN_API_ENABLED && configuredCount !== configuredTuple.length) {
    context.addIssue({
      code: "custom",
      message: "the complete workforce OIDC configuration is required when enabled",
      path: ["ADMIN_API_ENABLED"],
    });
  }
  if (value.ADMIN_API_ENABLED && value.ADMIN_AUDIT_SUBJECT_DIGEST_KEY === undefined) {
    context.addIssue({
      code: "custom",
      message: "an independent Admin audit subject digest key is required when enabled",
      path: ["ADMIN_AUDIT_SUBJECT_DIGEST_KEY"],
    });
  }
  if (
    value.ADMIN_AUDIT_SUBJECT_DIGEST_KEY !== undefined &&
    (value.ADMIN_AUDIT_SUBJECT_DIGEST_KEY === value.PENDING_ACTION_ENCRYPTION_KEY ||
      value.ADMIN_AUDIT_SUBJECT_DIGEST_KEY === value.AGENT_API_KEY_PEPPER)
  ) {
    context.addIssue({
      code: "custom",
      message: "must be independent from Agent and PendingAction secrets",
      path: ["ADMIN_AUDIT_SUBJECT_DIGEST_KEY"],
    });
  }
  if (
    !value.ADMIN_OIDC_ALLOW_AMR_MFA &&
    value.ADMIN_OIDC_ALLOWED_ACR_VALUES.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "at least one MFA assurance mechanism must be enabled",
      path: ["ADMIN_OIDC_ALLOW_AMR_MFA"],
    });
  }
  if (
    value.NODE_ENV === "production" &&
    configuredCount === configuredTuple.length &&
    (new URL(value.ADMIN_OIDC_ISSUER!).protocol !== "https:" ||
      new URL(value.ADMIN_OIDC_JWKS_URI!).protocol !== "https:")
  ) {
    context.addIssue({
      code: "custom",
      message: "workforce OIDC issuer and JWKS URLs must use https in production",
      path: ["ADMIN_OIDC_ISSUER"],
    });
  }
}

function validateProductionRedisTransport(
  value: { NODE_ENV: z.infer<typeof NodeEnvironmentSchema>; REDIS_URL: string },
  context: z.RefinementCtx,
): void {
  if (
    value.NODE_ENV === "production" &&
    new URL(value.REDIS_URL).protocol !== "rediss:"
  ) {
    context.addIssue({
      code: "custom",
      message: "must use rediss:// with TLS in production",
      path: ["REDIS_URL"],
    });
  }
}

function validateProductionPostgresTransport(
  value: { DATABASE_URL: string; NODE_ENV: z.infer<typeof NodeEnvironmentSchema> },
  context: z.RefinementCtx,
): void {
  if (value.NODE_ENV !== "production") return;

  const databaseUrl = new URL(value.DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.searchParams.getAll("sslmode").length !== 1 ||
    databaseUrl.searchParams.get("sslmode") !== "verify-full"
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must be a postgres URL with exactly one sslmode=verify-full setting in production",
      path: ["DATABASE_URL"],
    });
  }
}

function isCanonicalRemoteMcpOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2_048 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.toString() === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
}

const OptionalRemoteMcpOAuthUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .min(1)
    .max(2_048)
    .refine(
      isCanonicalRemoteMcpOAuthUrl,
      "must be a canonical HTTPS URL (or loopback HTTP URL) without credentials, query, or fragment",
    )
    .optional(),
);

function isCanonicalMcpInternalApiOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2_048 &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

const OptionalMcpInternalApiOriginSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .min(1)
    .max(2_048)
    .refine(
      isCanonicalMcpInternalApiOrigin,
      "must be a canonical HTTPS origin without a path, credentials, query, or fragment",
    )
    .optional(),
);

const McpActorAssertionEnvironmentFields = {
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64: OptionalMcpIndependentKeyBase64Schema,
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION: OptionalMcpKeyVersionSchema,
  MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: McpActorPreviousKeyRingSchema,
} satisfies z.ZodRawShape;

const McpInternalApiEnvironmentFields = {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: OptionalMcpIndependentKeyBase64Schema,
  MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS:
    McpCertificateFingerprintListSchema,
  MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64: OptionalMcpCertificatePemBase64Schema,
  MCP_INTERNAL_API_ENABLED: BooleanStringSchema.default(false),
  MCP_INTERNAL_API_PORT: PortSchema.default(RemoteMcpInternalApiDefaultPort),
  MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64: OptionalMcpCertificatePemBase64Schema,
  MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64: OptionalMcpPrivateKeyPemBase64Schema,
  MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64: OptionalMcpIndependentKeyBase64Schema,
  ...McpActorAssertionEnvironmentFields,
} satisfies z.ZodRawShape;

const McpRuntimeEnvironmentFields = {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64: OptionalMcpIndependentKeyBase64Schema,
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64: OptionalMcpCertificatePemBase64Schema,
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64: OptionalMcpPrivateKeyPemBase64Schema,
  MCP_INTERNAL_API_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(RemoteMcpInternalApiDefaultMaximumResponseBytes)
    .default(RemoteMcpInternalApiDefaultMaximumResponseBytes),
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64: OptionalMcpCertificatePemBase64Schema,
  MCP_INTERNAL_API_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(29_000)
    .default(RemoteMcpInternalApiDefaultTimeoutMilliseconds),
  MCP_INTERNAL_API_URL: OptionalMcpInternalApiOriginSchema,
  MCP_OAUTH_ISSUER: OptionalRemoteMcpOAuthUrlSchema,
  MCP_OAUTH_JWKS_URI: OptionalRemoteMcpOAuthUrlSchema,
  MCP_RUNTIME_ENABLED: BooleanStringSchema.default(false),
  ...McpActorAssertionEnvironmentFields,
} satisfies z.ZodRawShape;

type McpActorAssertionValidationTarget = {
  MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64?: Buffer | undefined;
  MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION?: number | undefined;
  MCP_ACTOR_ASSERTION_PREVIOUS_KEYS: Record<
    string,
    { keyBase64: Buffer; verificationExpiresAt: Date }
  >;
};

function validateMcpActorAssertionEnvironment(
  value: McpActorAssertionValidationTarget,
  context: z.RefinementCtx,
  required: boolean,
): void {
  const previousEntries = Object.entries(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS);
  const hasAnyConfiguration =
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64 !== undefined ||
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION !== undefined ||
    previousEntries.length > 0;
  const hasCurrentTuple =
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64 !== undefined &&
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION !== undefined;

  if (hasAnyConfiguration && !hasCurrentTuple) {
    context.addIssue({
      code: "custom",
      message:
        "current key version and key material must be configured together before adding previous keys",
      path: ["MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION"],
    });
  }
  if (required && !hasCurrentTuple) {
    context.addIssue({
      code: "custom",
      message: "a complete ActorContext assertion key ring is required when enabled",
      path: ["MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION"],
    });
  }
  if (
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION !== undefined &&
    Object.hasOwn(
      value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS,
      String(value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "must not include the current key version in the previous key ring",
      path: ["MCP_ACTOR_ASSERTION_PREVIOUS_KEYS"],
    });
  }
  if (previousEntries.length > 5) {
    context.addIssue({
      code: "custom",
      message: "must contain at most five previous ActorContext keys",
      path: ["MCP_ACTOR_ASSERTION_PREVIOUS_KEYS"],
    });
  }
  const keyMaterial = [
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64,
    ...previousEntries.map(([, entry]) => entry.keyBase64),
  ].filter((entry): entry is Buffer => entry !== undefined);
  if (
    keyMaterial.some((entry, index) =>
      keyMaterial.slice(index + 1).some((other) => entry.equals(other)),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "must not reuse ActorContext key material across versions",
      path: ["MCP_ACTOR_ASSERTION_PREVIOUS_KEYS"],
    });
  }
}

function validateCertificateAndPrivateKeyPair(
  certificate: Buffer | undefined,
  privateKey: Buffer | undefined,
  context: z.RefinementCtx,
  path: string,
): void {
  if (certificate === undefined || privateKey === undefined) return;
  try {
    createSecureContext({ cert: certificate, key: privateKey });
  } catch {
    context.addIssue({
      code: "custom",
      message: "certificate and private key must be a valid matching TLS identity",
      path: [path],
    });
  }
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left !== undefined && right !== undefined && left.equals(right);
}

type McpInternalApiValidationTarget = McpActorAssertionValidationTarget & {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64?: Buffer | undefined;
  MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS: string[];
  MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_ENABLED: boolean;
  MCP_INTERNAL_API_PORT: number;
  MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64?: Buffer | undefined;
  PORT: number;
};

function validateMcpInternalApiEnvironment(
  value: McpInternalApiValidationTarget,
  context: z.RefinementCtx,
): void {
  const tlsTuple = [
    value.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64,
    value.MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64,
    value.MCP_INTERNAL_API_CLIENT_CA_PEM_BASE64,
  ];
  const actorTupleConfigured =
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64 !== undefined ||
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION !== undefined ||
    Object.keys(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).length > 0;
  const hasAnyConfiguration =
    tlsTuple.some((entry) => entry !== undefined) ||
    value.MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS.length > 0 ||
    actorTupleConfigured ||
    value.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64 !== undefined ||
    value.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64 !== undefined;
  const tupleRequired = value.MCP_INTERNAL_API_ENABLED || hasAnyConfiguration;

  if (
    tupleRequired &&
    (tlsTuple.some((entry) => entry === undefined) ||
      value.MCP_INTERNAL_API_ALLOWED_CLIENT_CERT_SHA256_FINGERPRINTS.length < 1)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "server certificate, matching key, client CA, and at least one pinned client fingerprint are required together",
      path: ["MCP_INTERNAL_API_ENABLED"],
    });
  }
  validateMcpActorAssertionEnvironment(value, context, tupleRequired);
  if (tupleRequired && value.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64 === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "an independent ActorContext replay digest key is required when configured",
      path: ["MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64"],
    });
  }
  if (tupleRequired && value.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64 === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "the shared Access Token jti digest key is required when Remote MCP is configured",
      path: ["MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"],
    });
  }
  const replayDigestKey = value.MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64;
  const accessTokenJtiDigestKey = value.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64;
  if (
    replayDigestKey !== undefined &&
    (buffersEqual(replayDigestKey, value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64) ||
      Object.values(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).some((entry) =>
        entry.keyBase64.equals(replayDigestKey),
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "must be independent from every ActorContext signing key",
      path: ["MCP_ACTOR_ASSERTION_REPLAY_DIGEST_KEY_BASE64"],
    });
  }
  if (
    accessTokenJtiDigestKey !== undefined &&
    (buffersEqual(accessTokenJtiDigestKey, replayDigestKey) ||
      buffersEqual(
        accessTokenJtiDigestKey,
        value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64,
      ) ||
      Object.values(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).some((entry) =>
        entry.keyBase64.equals(accessTokenJtiDigestKey),
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "must be independent from ActorContext signing and replay digest keys",
      path: ["MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"],
    });
  }
  if (tupleRequired && value.MCP_INTERNAL_API_PORT === value.PORT) {
    context.addIssue({
      code: "custom",
      message: "must use a listener port distinct from the public API port",
      path: ["MCP_INTERNAL_API_PORT"],
    });
  }
  validateCertificateAndPrivateKeyPair(
    value.MCP_INTERNAL_API_SERVER_CERT_PEM_BASE64,
    value.MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64,
    context,
    "MCP_INTERNAL_API_SERVER_KEY_PEM_BASE64",
  );
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
  ...AdminApiEnvironmentFields,
  ...AgentCredentialEnvironmentFields,
  ...McpInternalApiEnvironmentFields,
  ...PendingActionCryptoEnvironmentFields,
  ...SearchEmbeddingEnvironmentFields,
  API_TRUSTED_PROXY_CIDRS: TrustedProxyListSchema,
  COMMUNITY_CURSOR_SIGNING_KEY: AuthSecretSchema.default(
    LocalDevelopmentCommunityCursorSigningKey,
  ),
  SSR_INTERNAL_REQUEST_SECRET: AuthSecretSchema.default(
    LocalDevelopmentSsrInternalRequestSecret,
  ),
  PORT: PortSchema.default(4000),
  DATABASE_URL: UrlSchema,
  REDIS_URL: UrlSchema,
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
}).superRefine((value, context) => {
  validateAuthEnvironment(value, context);
  validateAdminApiEnvironment(value, context);
  validateMcpInternalApiEnvironment(value, context);
  validatePendingActionCryptoEnvironment(value, context);
  validateProductionPostgresTransport(value, context);
  validateProductionRedisTransport(value, context);

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

  if (
    value.NODE_ENV === "production" &&
    value.SSR_INTERNAL_REQUEST_SECRET === LocalDevelopmentSsrInternalRequestSecret
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must not use the repository local-development SSR request secret in production",
      path: ["SSR_INTERNAL_REQUEST_SECRET"],
    });
  }

  if (
    value.NODE_ENV === "production" &&
    value.COMMUNITY_CURSOR_SIGNING_KEY === LocalDevelopmentCommunityCursorSigningKey
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must not use the repository local-development Community cursor secret in production",
      path: ["COMMUNITY_CURSOR_SIGNING_KEY"],
    });
  }

  if (value.AGENT_CREDENTIAL_ACTIVE_PER_OWNER < value.AGENT_CREDENTIAL_ACTIVE_PER_AGENT) {
    context.addIssue({
      code: "custom",
      message: "must be at least AGENT_CREDENTIAL_ACTIVE_PER_AGENT",
      path: ["AGENT_CREDENTIAL_ACTIVE_PER_OWNER"],
    });
  }

  if (value.AGENT_CREDENTIAL_DEFAULT_TTL_DAYS > value.AGENT_CREDENTIAL_MAX_TTL_DAYS) {
    context.addIssue({
      code: "custom",
      message: "must not exceed AGENT_CREDENTIAL_MAX_TTL_DAYS",
      path: ["AGENT_CREDENTIAL_DEFAULT_TTL_DAYS"],
    });
  }

  if (
    value.NODE_ENV === "production" &&
    (value.AGENT_API_KEY_PEPPER === LocalDevelopmentAgentApiKeyPepper ||
      Object.values(value.AGENT_API_KEY_PREVIOUS_PEPPERS).includes(
        LocalDevelopmentAgentApiKeyPepper,
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "must not use the repository local-development pepper in production",
      path: ["AGENT_API_KEY_PEPPER"],
    });
  }

  if (
    Object.hasOwn(
      value.AGENT_API_KEY_PREVIOUS_PEPPERS,
      String(value.AGENT_API_KEY_PEPPER_VERSION),
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must not duplicate AGENT_API_KEY_PEPPER_VERSION in AGENT_API_KEY_PREVIOUS_PEPPERS",
      path: ["AGENT_API_KEY_PREVIOUS_PEPPERS"],
    });
  }

  if (Object.keys(value.AGENT_API_KEY_PREVIOUS_PEPPERS).length > 5) {
    context.addIssue({
      code: "custom",
      message: "must contain at most five previous pepper versions",
      path: ["AGENT_API_KEY_PREVIOUS_PEPPERS"],
    });
  }

  if (
    new Set([
      value.AGENT_API_KEY_PEPPER,
      ...Object.values(value.AGENT_API_KEY_PREVIOUS_PEPPERS),
    ]).size !==
    1 + Object.keys(value.AGENT_API_KEY_PREVIOUS_PEPPERS).length
  ) {
    context.addIssue({
      code: "custom",
      message: "must not reuse a pepper secret across versions",
      path: ["AGENT_API_KEY_PREVIOUS_PEPPERS"],
    });
  }
});
export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;

function isCanonicalMcpResource(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/mcp" &&
      url.toString() === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
}

const OptionalMcpResourceSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .min(1)
    .max(500)
    .refine(
      isCanonicalMcpResource,
      "must be a canonical https /mcp resource URL (or loopback http URL)",
    )
    .optional(),
);

type McpRuntimeValidationTarget = McpActorAssertionValidationTarget & {
  MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_SERVER_CA_PEM_BASE64?: Buffer | undefined;
  MCP_INTERNAL_API_URL?: string | undefined;
  MCP_OAUTH_ISSUER?: string | undefined;
  MCP_OAUTH_JWKS_URI?: string | undefined;
  MCP_PUBLIC_ENABLED: boolean;
  MCP_RESOURCE?: string | undefined;
  MCP_RUNTIME_ENABLED: boolean;
  NODE_ENV: z.infer<typeof NodeEnvironmentSchema>;
};

function validateMcpRuntimeEnvironment(
  value: McpRuntimeValidationTarget,
  context: z.RefinementCtx,
): void {
  const runtimeTuple = [
    value.MCP_RESOURCE,
    value.MCP_OAUTH_ISSUER,
    value.MCP_OAUTH_JWKS_URI,
    value.MCP_INTERNAL_API_URL,
    value.MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64,
    value.MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64,
    value.MCP_INTERNAL_API_SERVER_CA_PEM_BASE64,
    value.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64,
  ];
  const actorTupleConfigured =
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64 !== undefined ||
    value.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION !== undefined ||
    Object.keys(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).length > 0;
  const hasAnyConfiguration =
    runtimeTuple.some((entry) => entry !== undefined) || actorTupleConfigured;
  const tupleRequired = value.MCP_RUNTIME_ENABLED || hasAnyConfiguration;

  if (tupleRequired && runtimeTuple.some((entry) => entry === undefined)) {
    context.addIssue({
      code: "custom",
      message:
        "the OAuth verifier, internal mTLS client, and token-jti digest tuple must be configured together",
      path: ["MCP_RUNTIME_ENABLED"],
    });
  }
  validateMcpActorAssertionEnvironment(value, context, tupleRequired);
  const tokenJtiDigestKey = value.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64;
  if (
    tokenJtiDigestKey !== undefined &&
    (buffersEqual(tokenJtiDigestKey, value.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64) ||
      Object.values(value.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).some((entry) =>
        entry.keyBase64.equals(tokenJtiDigestKey),
      ))
  ) {
    context.addIssue({
      code: "custom",
      message: "must be independent from every ActorContext signing key",
      path: ["MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"],
    });
  }
  if (value.MCP_PUBLIC_ENABLED && !value.MCP_RUNTIME_ENABLED) {
    context.addIssue({
      code: "custom",
      message: "must be true before public MCP exposure can be enabled",
      path: ["MCP_RUNTIME_ENABLED"],
    });
  }
  if (
    value.NODE_ENV === "production" &&
    value.MCP_OAUTH_ISSUER !== undefined &&
    value.MCP_OAUTH_JWKS_URI !== undefined &&
    (new URL(value.MCP_OAUTH_ISSUER).protocol !== "https:" ||
      new URL(value.MCP_OAUTH_JWKS_URI).protocol !== "https:")
  ) {
    context.addIssue({
      code: "custom",
      message: "OAuth issuer and JWKS URLs must use https in production",
      path: ["MCP_OAUTH_ISSUER"],
    });
  }
  validateCertificateAndPrivateKeyPair(
    value.MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64,
    value.MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64,
    context,
    "MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64",
  );
}

export const McpEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  PORT: PortSchema.default(4100),
  REDIS_URL: UrlSchema,
  ...McpRuntimeEnvironmentFields,
  MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1,mcp"),
  MCP_PUBLIC_ENABLED: BooleanStringSchema.default(false),
  MCP_RESOURCE: OptionalMcpResourceSchema,
  MCP_TRUSTED_PROXY_CIDRS: TrustedProxyListSchema,
}).superRefine((value, context) => {
  validateProductionRedisTransport(value, context);
  validateMcpRuntimeEnvironment(value, context);
  if (value.MCP_PUBLIC_ENABLED && !value.MCP_RESOURCE) {
    context.addIssue({
      code: "custom",
      message: "is required when MCP_PUBLIC_ENABLED=true",
      path: ["MCP_RESOURCE"],
    });
  }
  if (
    value.NODE_ENV === "production" &&
    value.MCP_RESOURCE &&
    !value.MCP_RESOURCE.startsWith("https://")
  ) {
    context.addIssue({
      code: "custom",
      message: "must use https in production",
      path: ["MCP_RESOURCE"],
    });
  }
  if (
    value.NODE_ENV === "production" &&
    value.MCP_PUBLIC_ENABLED &&
    value.MCP_TRUSTED_PROXY_CIDRS.length < 1
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must name at least one trusted ingress IP or CIDR when public MCP access is enabled",
      path: ["MCP_TRUSTED_PROXY_CIDRS"],
    });
  }
});
export type McpEnvironment = z.infer<typeof McpEnvironmentSchema>;

export const WorkerEnvironmentSchema = CommonServiceEnvironmentSchema.extend({
  ...PendingActionCryptoEnvironmentFields,
  ...SearchEmbeddingEnvironmentFields,
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
  SEARCH_INDEX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  SEARCH_INDEX_LEASE_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
  RUN_ONCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
}).superRefine((value, context) => {
  validatePendingActionCryptoEnvironment(value, context);
  validateProductionPostgresTransport(value, context);
  if (
    value.SEARCH_INDEX_LEASE_SECONDS * 1_000 <=
    value.SEARCH_EMBEDDING_TIMEOUT_MS + SearchIndexDatabaseMarginMilliseconds
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must exceed SEARCH_EMBEDDING_TIMEOUT_MS plus the 5000 ms database completion margin",
      path: ["SEARCH_INDEX_LEASE_SECONDS"],
    });
  }
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
