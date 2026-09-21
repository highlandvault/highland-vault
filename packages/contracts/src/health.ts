import { z } from 'zod';

export const DependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/** GET /health/live — the API process is running. No dependency checks. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

/** GET /health/ready — 200 when every required dependency is up, otherwise 503. */
export const ReadinessResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: DependencyCheckSchema,
    redis: DependencyCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
