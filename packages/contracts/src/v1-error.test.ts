import { describe, expect, it } from "vitest";

import { V1ErrorDetailSchema, V1ErrorResponseSchema } from "./v1-error.js";

describe("V1ErrorResponseSchema", () => {
  it("accepts the structured snake_case v1 error envelope", () => {
    const response = {
      error: {
        code: "VERSION_CONFLICT",
        message: "The resource changed after the expected version.",
        retryable: false,
        details: {
          expected_version: 2,
          current_version: 3,
        },
        retry_after_ms: null,
      },
      request_id: "req-version-conflict",
      schema_version: "1",
    } as const;

    expect(V1ErrorResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects unstructured extras at both envelope levels", () => {
    const error = {
      code: "NOT_FOUND",
      message: "The resource does not exist.",
      retryable: false,
      details: null,
      retry_after_ms: null,
    } as const;

    expect(
      V1ErrorResponseSchema.safeParse({
        error: {
          ...error,
          stack: "secret internal stack",
        },
        request_id: "req-not-found",
        schema_version: "1",
      }).success,
    ).toBe(false);
    expect(
      V1ErrorResponseSchema.safeParse({
        error,
        request_id: "req-not-found",
        schema_version: "1",
        debug: true,
      }).success,
    ).toBe(false);
  });

  it("requires retry metadata for rate limits", () => {
    expect(
      V1ErrorDetailSchema.safeParse({
        code: "RATE_LIMITED",
        message: "Try again later.",
        retryable: false,
        details: null,
        retry_after_ms: null,
      }).success,
    ).toBe(false);
    expect(
      V1ErrorDetailSchema.safeParse({
        code: "RATE_LIMITED",
        message: "Try again later.",
        retryable: true,
        details: null,
        retry_after_ms: 1_000,
      }).success,
    ).toBe(true);
  });
});
