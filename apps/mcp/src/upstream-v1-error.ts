import { V1ErrorResponseSchema, type V1ErrorResponse } from "@alphanet/contracts";

import { InternalMcpApiClientError } from "./internal-api-client.js";

export const PRIVATE_MCP_BOUNDARY_ERROR_STATUS = {
  POLICY_DENIED: 403,
  RATE_LIMITED: 429,
  REMOTE_MCP_ACTOR_AUTHENTICATION_FAILED: 401,
  REMOTE_MCP_ACTOR_AUTHENTICATION_UNAVAILABLE: 503,
  REMOTE_MCP_TRANSPORT_AUTHENTICATION_FAILED: 401,
  REMOTE_MCP_TRANSPORT_AUTHENTICATION_UNAVAILABLE: 503,
  SCOPE_REQUIRED: 403,
  TEMPORARILY_UNAVAILABLE: 503,
} as const satisfies Readonly<Record<string, number>>;

export function invalidUpstreamResponse(): never {
  throw new InternalMcpApiClientError("INVALID_RESPONSE");
}

export function assertUpstreamRequestId(
  actualRequestId: string,
  expectedRequestId: string,
): void {
  if (actualRequestId !== expectedRequestId) {
    invalidUpstreamResponse();
  }
}

export function normalizeUpstreamV1Error(
  statusCode: number,
  payload: unknown,
  expectedRequestId: string,
  statusCodeByErrorCode: Readonly<Record<string, number>>,
): V1ErrorResponse {
  const parsed = V1ErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return invalidUpstreamResponse();
  }

  const code = parsed.data.error.code;
  if (
    !Object.hasOwn(statusCodeByErrorCode, code) ||
    statusCodeByErrorCode[code] !== statusCode
  ) {
    return invalidUpstreamResponse();
  }
  assertUpstreamRequestId(parsed.data.request_id, expectedRequestId);
  return parsed.data;
}
