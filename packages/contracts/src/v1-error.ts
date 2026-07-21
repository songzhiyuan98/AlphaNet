import { z } from "zod";

import { V1_SCHEMA_VERSION } from "./agent.ts";

export const V1ErrorDetailSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.json()).nullable(),
    retry_after_ms: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((error, context) => {
    if (
      error.code === "RATE_LIMITED" &&
      (!error.retryable || error.retry_after_ms === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "RATE_LIMITED errors must be retryable and include a positive retry_after_ms.",
      });
    }
  });
export type V1ErrorDetail = z.infer<typeof V1ErrorDetailSchema>;

export const V1ErrorResponseSchema = z
  .object({
    error: V1ErrorDetailSchema,
    request_id: z.string().min(1).max(200),
    schema_version: z.literal(V1_SCHEMA_VERSION),
  })
  .strict();
export type V1ErrorResponse = z.infer<typeof V1ErrorResponseSchema>;
