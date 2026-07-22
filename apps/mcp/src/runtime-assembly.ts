import { createMcpActorAssertionKeyRing, RedisRateLimitStorage } from "@alphanet/auth";
import type { McpEnvironment } from "@alphanet/config";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";

import type { McpActorRateLimiter, McpRequestRateLimiter } from "./app.js";
import { createRemoteMcpAccessTokenVerifier } from "./access-token-verifier.js";
import { createBrowseContentTool } from "./browse-content-tool.js";
import { createCreatePostTool } from "./create-post-tool.js";
import { createDeleteContentTool } from "./delete-content-tool.js";
import { createFindCommunitiesTool } from "./find-communities-tool.js";
import { createGetActionStatusTool } from "./get-action-status-tool.js";
import { createGetAgentContextTool } from "./get-agent-context-tool.js";
import { createGetCommunityTool } from "./get-community-tool.js";
import { createGetContentTool } from "./get-content-tool.js";
import { createGetDiscussionTool } from "./get-discussion-tool.js";
import { createInternalMcpApiClient } from "./internal-api-client.js";
import { createListFollowsTool } from "./list-follows-tool.js";
import { createListNotificationsTool } from "./list-notifications-tool.js";
import type { McpToolRegistration } from "./protocol.js";
import {
  createMcpActorRateLimiter,
  createMcpRequestRateLimiter,
} from "./rate-limiters.js";
import { createReplyToContentTool } from "./reply-to-content-tool.js";
import { createSearchContentTool } from "./search-content-tool.js";
import { createSetFollowTool } from "./set-follow-tool.js";
import { createSetReactionTool } from "./set-reaction-tool.js";
import { createStrictBearerAuthorizationMiddleware } from "./strict-bearer-auth.js";
import { createUpdateContentTool } from "./update-content-tool.js";

type McpRuntimeEnvironment = Pick<
  McpEnvironment,
  | "MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64"
  | "MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64"
  | "MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION"
  | "MCP_ACTOR_ASSERTION_PREVIOUS_KEYS"
  | "MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64"
  | "MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64"
  | "MCP_INTERNAL_API_MAX_RESPONSE_BYTES"
  | "MCP_INTERNAL_API_SERVER_CA_PEM_BASE64"
  | "MCP_INTERNAL_API_TIMEOUT_MS"
  | "MCP_INTERNAL_API_URL"
  | "MCP_OAUTH_ISSUER"
  | "MCP_OAUTH_JWKS_URI"
  | "MCP_RESOURCE"
  | "MCP_RUNTIME_ENABLED"
>;

type RedisRateLimitClient = ConstructorParameters<typeof RedisRateLimitStorage>[0];

export type McpRuntimeAssembly =
  | {
      runtimeEnabled: false;
      tools: readonly McpToolRegistration[];
    }
  | {
      actorRateLimiter: McpActorRateLimiter;
      authorizationMiddleware: ReturnType<
        typeof createStrictBearerAuthorizationMiddleware
      >;
      oauthIssuer: string;
      requestRateLimiter: McpRequestRateLimiter;
      resource: string;
      runtimeEnabled: true;
      tools: readonly McpToolRegistration[];
    };

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Remote MCP runtime configuration is incomplete");
  }
  return value;
}

/**
 * Assembles the protected Remote MCP runtime only after the strict environment
 * tuple has passed validation. Public exposure is deliberately absent here;
 * that remains an independent edge/network decision.
 */
export function createMcpRuntimeAssembly(
  environment: McpRuntimeEnvironment,
  redisClient: RedisRateLimitClient,
): McpRuntimeAssembly {
  if (!environment.MCP_RUNTIME_ENABLED) {
    return Object.freeze({
      runtimeEnabled: false,
      tools: Object.freeze([]),
    });
  }

  const resource = required(environment.MCP_RESOURCE);
  const oauthIssuer = required(environment.MCP_OAUTH_ISSUER);
  const actorAssertionKeyRing = createMcpActorAssertionKeyRing({
    currentKey: required(environment.MCP_ACTOR_ASSERTION_CURRENT_KEY_BASE64),
    currentVersion: required(environment.MCP_ACTOR_ASSERTION_CURRENT_KEY_VERSION),
    previousKeys: Object.fromEntries(
      Object.entries(environment.MCP_ACTOR_ASSERTION_PREVIOUS_KEYS).map(
        ([version, entry]) => [
          Number(version),
          {
            key: entry.keyBase64,
            verificationExpiresAt: entry.verificationExpiresAt,
          },
        ],
      ),
    ),
  });
  const internalApiClient = createInternalMcpApiClient({
    assertionKeyRing: actorAssertionKeyRing,
    baseUrl: required(environment.MCP_INTERNAL_API_URL),
    maxResponseBytes: environment.MCP_INTERNAL_API_MAX_RESPONSE_BYTES,
    timeoutMilliseconds: environment.MCP_INTERNAL_API_TIMEOUT_MS,
    tls: {
      ca: required(environment.MCP_INTERNAL_API_SERVER_CA_PEM_BASE64),
      cert: required(environment.MCP_INTERNAL_API_CLIENT_CERT_PEM_BASE64),
      key: required(environment.MCP_INTERNAL_API_CLIENT_KEY_PEM_BASE64),
    },
  });
  const verifier = createRemoteMcpAccessTokenVerifier({
    issuer: oauthIssuer,
    jwksUrl: required(environment.MCP_OAUTH_JWKS_URI),
    resource,
    tokenJtiDigestKey: required(environment.MCP_ACCESS_TOKEN_JTI_DIGEST_KEY_BASE64),
  });
  const rateLimitStorage = new RedisRateLimitStorage(
    redisClient,
    "alphanet:remote-mcp:rate-limit:",
  );
  const tools = Object.freeze([
    createGetAgentContextTool(internalApiClient),
    createFindCommunitiesTool(internalApiClient),
    createGetCommunityTool(internalApiClient),
    createBrowseContentTool(internalApiClient),
    createSearchContentTool(internalApiClient),
    createGetContentTool(internalApiClient),
    createGetDiscussionTool(internalApiClient),
    createListNotificationsTool(internalApiClient),
    createGetActionStatusTool(internalApiClient),
    createCreatePostTool(internalApiClient),
    createReplyToContentTool(internalApiClient),
    createUpdateContentTool(internalApiClient),
    createDeleteContentTool(internalApiClient),
    createSetReactionTool(internalApiClient),
    createSetFollowTool(internalApiClient),
    createListFollowsTool(internalApiClient),
  ]);

  return Object.freeze({
    actorRateLimiter: createMcpActorRateLimiter(rateLimitStorage),
    authorizationMiddleware: createStrictBearerAuthorizationMiddleware({
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
        new URL(resource),
      ).toString(),
      verifier,
    }),
    oauthIssuer,
    requestRateLimiter: createMcpRequestRateLimiter(rateLimitStorage),
    resource,
    runtimeEnabled: true,
    tools,
  });
}
