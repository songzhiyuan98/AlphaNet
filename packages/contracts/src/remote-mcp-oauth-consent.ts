import { z } from "zod";

import {
  AGENT_SCOPES,
  AgentDisplayNameSchema,
  AgentHandleSchema,
  AgentPermissionTierSchema,
  TimestampSchema,
  UuidSchema,
  V1EnvelopeShape,
} from "./agent.ts";

export const REMOTE_MCP_OAUTH_QUERY_MAX_BYTES = 16_384;
export const REMOTE_MCP_OAUTH_CONTINUATION_HANDLE_MAX_LENGTH = 512;

const RemoteMcpOAuthQuerySchema = z
  .string()
  .min(1)
  .max(REMOTE_MCP_OAUTH_QUERY_MAX_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= REMOTE_MCP_OAUTH_QUERY_MAX_BYTES,
    `OAuth query cannot exceed ${REMOTE_MCP_OAUTH_QUERY_MAX_BYTES} UTF-8 bytes.`,
  );

export const RemoteMcpOAuthContinuationHandleSchema = z
  .string()
  .min(1)
  .max(REMOTE_MCP_OAUTH_CONTINUATION_HANDLE_MAX_LENGTH)
  .regex(
    /^[A-Za-z0-9_-]+$/u,
    "Continuation handles must use unpadded base64url encoding.",
  );

export const OwnerRemoteMcpOAuthConsentInspectRequestSchema = z
  .object({
    oauth_query: RemoteMcpOAuthQuerySchema,
    continuation_handle: RemoteMcpOAuthContinuationHandleSchema.optional(),
  })
  .strict();
export type OwnerRemoteMcpOAuthConsentInspectRequest = z.infer<
  typeof OwnerRemoteMcpOAuthConsentInspectRequestSchema
>;

export const OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema = z
  .object({
    oauth_query: RemoteMcpOAuthQuerySchema,
    agent_id: UuidSchema,
  })
  .strict();
export type OwnerRemoteMcpOAuthConsentSelectAgentRequest = z.infer<
  typeof OwnerRemoteMcpOAuthConsentSelectAgentRequestSchema
>;

export const RemoteMcpOAuthConsentPhaseSchema = z.enum([
  "agent_selection",
  "consent_review",
]);
export type RemoteMcpOAuthConsentPhase = z.infer<typeof RemoteMcpOAuthConsentPhaseSchema>;

export const RemoteMcpOAuthConsentScopeSchema = z.enum([
  ...AGENT_SCOPES,
  "offline_access",
]);
export type RemoteMcpOAuthConsentScope = z.infer<typeof RemoteMcpOAuthConsentScopeSchema>;

const uniqueArray = <Value>(values: readonly Value[]) =>
  new Set(values).size === values.length;

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
const WHITESPACE = /\s/u;

const containsControlOrWhitespace = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      WHITESPACE.test(character)
    );
  });

const validRemoteMcpRedirectUri = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      new TextEncoder().encode(value).byteLength <= 2_048 &&
      !containsControlOrWhitespace(value) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
};

export const RemoteMcpOAuthConsentRedirectUriSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    validRemoteMcpRedirectUri,
    "Redirect URIs must use HTTPS (or loopback HTTP) without credentials or fragments.",
  );

export const RemoteMcpOAuthConsentRequestedScopesSchema = z
  .array(RemoteMcpOAuthConsentScopeSchema)
  .min(1)
  .max(RemoteMcpOAuthConsentScopeSchema.options.length)
  .refine(uniqueArray, "Requested OAuth scopes must be unique.")
  .refine(
    (scopes) => scopes.some((scope) => scope !== "offline_access"),
    "At least one Agent scope must be requested.",
  );

const canonicalRemoteMcpResource = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.toString() === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/mcp" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
};

export const RemoteMcpOAuthCanonicalResourceSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    canonicalRemoteMcpResource,
    "Remote MCP resources must use the canonical absolute /mcp URL.",
  );

const canonicalRedirectOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
};

export const RemoteMcpOAuthConsentClientSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    redirect_origin: z
      .string()
      .min(1)
      .max(500)
      .refine(canonicalRedirectOrigin, "Redirect origins must be canonical."),
    redirect_uri: RemoteMcpOAuthConsentRedirectUriSchema,
  })
  .strict()
  .superRefine((client, context) => {
    let redirectOrigin: string;
    try {
      redirectOrigin = new URL(client.redirect_uri).origin;
    } catch {
      return;
    }
    if (redirectOrigin !== client.redirect_origin) {
      context.addIssue({
        code: "custom",
        path: ["redirect_uri"],
        message: "The redirect URI must belong to the verified redirect origin.",
      });
    }
  });

export const RemoteMcpOAuthConsentAgentPolicySchema = z
  .object({
    tier: AgentPermissionTierSchema,
    defaults_version: z.string().min(1).max(100),
    schema_version: z.number().int().positive().safe(),
    version: z
      .string()
      .regex(/^[1-9][0-9]*$/u, "Policy versions must be positive decimal strings."),
  })
  .strict();

export const RemoteMcpOAuthCredentialPolicyCeilingSchema = z
  .object({
    tier: AgentPermissionTierSchema,
    defaults_version: z.string().min(1).max(100),
    schema_version: z.number().int().positive().safe(),
  })
  .strict();

export const RemoteMcpOAuthConsentAgentSchema = z
  .object({
    id: UuidSchema,
    handle: AgentHandleSchema,
    display_name: AgentDisplayNameSchema,
    policy: RemoteMcpOAuthConsentAgentPolicySchema,
  })
  .strict();

const RemoteMcpOAuthConsentSafeViewShape = {
  phase: RemoteMcpOAuthConsentPhaseSchema,
  client: RemoteMcpOAuthConsentClientSchema,
  resource: RemoteMcpOAuthCanonicalResourceSchema,
  requested_scopes: RemoteMcpOAuthConsentRequestedScopesSchema,
  expires_at: TimestampSchema,
  selected_agent_id: UuidSchema.nullable(),
  credential_policy_ceiling: RemoteMcpOAuthCredentialPolicyCeilingSchema.nullable(),
  agents: z.array(RemoteMcpOAuthConsentAgentSchema),
} as const;

type SafeConsentView = {
  phase: RemoteMcpOAuthConsentPhase;
  selected_agent_id: string | null;
  credential_policy_ceiling: z.infer<
    typeof RemoteMcpOAuthCredentialPolicyCeilingSchema
  > | null;
  agents: ReadonlyArray<{ id: string }>;
};

function validateSafeConsentView(view: SafeConsentView, context: z.RefinementCtx): void {
  const expectsSelection = view.phase === "consent_review";
  if (expectsSelection !== (view.selected_agent_id !== null)) {
    context.addIssue({
      code: "custom",
      path: ["selected_agent_id"],
      message: "Consent review requires a selected Agent; Agent selection requires null.",
    });
    return;
  }
  if (expectsSelection !== (view.credential_policy_ceiling !== null)) {
    context.addIssue({
      code: "custom",
      path: ["credential_policy_ceiling"],
      message:
        "Consent review requires the frozen Credential policy ceiling; Agent selection requires null.",
    });
  }
  if (
    view.selected_agent_id !== null &&
    !view.agents.some((agent) => agent.id === view.selected_agent_id)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selected_agent_id"],
      message: "The selected Agent must be present in the safe Agent list.",
    });
  }
}

export const OwnerRemoteMcpOAuthConsentInspectResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    ...RemoteMcpOAuthConsentSafeViewShape,
  })
  .strict()
  .superRefine(validateSafeConsentView);
export type OwnerRemoteMcpOAuthConsentInspectResponse = z.infer<
  typeof OwnerRemoteMcpOAuthConsentInspectResponseSchema
>;

export const OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema = z
  .object({
    ...V1EnvelopeShape,
    ...RemoteMcpOAuthConsentSafeViewShape,
    continuation_handle: RemoteMcpOAuthContinuationHandleSchema,
    grant_expires_at: TimestampSchema,
    idempotent: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    validateSafeConsentView(response, context);
    if (response.phase !== "consent_review") {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Selecting an Agent must advance the response to consent review.",
      });
    }
  });
export type OwnerRemoteMcpOAuthConsentSelectAgentResponse = z.infer<
  typeof OwnerRemoteMcpOAuthConsentSelectAgentResponseSchema
>;
