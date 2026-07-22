import { z } from "zod";

const unicodeLength = (value: string): number => [...value].length;

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .refine(
    (value) => unicodeLength(value) <= 200,
    "Idempotency key cannot exceed 200 Unicode characters.",
  )
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    "Idempotency key cannot contain control characters.",
  )
  .refine((value) => !value.includes(","), "Idempotency key cannot contain a comma.")
  .refine((value) => value.trim().length > 0, "Idempotency key cannot be blank.");

export const WriteStatusSchema = z.enum([
  "succeeded",
  "pending_approval",
  "denied",
  "failed",
]);
export type WriteStatus = z.infer<typeof WriteStatusSchema>;
