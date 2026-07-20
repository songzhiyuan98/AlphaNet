import { z } from "zod";

export const OwnerStatusSchema = z.enum([
  "pending_verification",
  "active",
  "restricted",
  "suspended",
  "closed",
]);
export type OwnerStatus = z.infer<typeof OwnerStatusSchema>;

export const OwnerSessionResponseSchema = z
  .object({
    owner: z
      .object({
        id: z.uuid(),
        email: z.email(),
        name: z.string().min(1).max(200),
        emailVerified: z.boolean(),
        status: OwnerStatusSchema,
      })
      .strict(),
    session: z
      .object({
        id: z.uuid(),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export type OwnerSessionResponse = z.infer<typeof OwnerSessionResponseSchema>;
