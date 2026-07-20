import { z } from "zod";

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CursorPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
  });
