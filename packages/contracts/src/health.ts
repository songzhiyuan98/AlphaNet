import { z } from "zod";

export const ServiceNameSchema = z.enum(["api", "mcp", "web", "worker"]);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const HealthStatusSchema = z.enum(["ok", "degraded"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  service: ServiceNameSchema,
  version: z.string().min(1),
  timestamp: z.iso.datetime(),
  failedDependencies: z.array(z.string().min(1)).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SystemStatusResponseSchema = z.object({
  name: z.literal("AlphaNet"),
  service: ServiceNameSchema,
  version: z.string().min(1),
  environment: z.enum(["development", "test", "production"]),
  uptimeSeconds: z.number().nonnegative(),
  requestId: z.string().min(1),
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;

export function createHealthResponse(
  service: ServiceName,
  version: string,
  failedDependencies: string[] = [],
  now = new Date(),
): HealthResponse {
  if (failedDependencies.length > 0) {
    return HealthResponseSchema.parse({
      status: "degraded",
      service,
      version,
      timestamp: now.toISOString(),
      failedDependencies,
    });
  }

  return HealthResponseSchema.parse({
    status: "ok",
    service,
    version,
    timestamp: now.toISOString(),
  });
}
