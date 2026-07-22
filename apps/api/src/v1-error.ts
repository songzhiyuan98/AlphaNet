import type { V1ErrorDetail, V1ErrorResponse } from "@alphanet/contracts";
import type { FastifyRequest } from "fastify";

export function v1Error(
  request: FastifyRequest,
  options: {
    code: string;
    message: string;
    retryable?: boolean | undefined;
    retryAt?: Date | undefined;
    details?: V1ErrorDetail["details"] | undefined;
  },
): V1ErrorResponse {
  const retryAfterMilliseconds = options.retryAt
    ? Math.max(1, options.retryAt.valueOf() - Date.now())
    : null;
  return {
    error: {
      code: options.code,
      message: options.message,
      retryable: options.retryable ?? false,
      details:
        options.details ??
        (options.retryAt ? { retry_at: options.retryAt.toISOString() } : null),
      retry_after_ms: retryAfterMilliseconds,
    },
    request_id: request.id,
    schema_version: "1",
  };
}
