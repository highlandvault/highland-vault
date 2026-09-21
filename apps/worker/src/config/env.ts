import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Validated worker environment. Startup fails fast on anything missing or malformed. */
export const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
  REDIS_URL: z.url().refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export function parseWorkerEnv(source: NodeJS.ProcessEnv): WorkerEnv {
  const result = WorkerEnvSchema.safeParse(source);
  if (!result.success) {
    // Variable names and reasons only — never values.
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${details}`);
  }
  return result.data;
}

export const WORKER_ENV = Symbol('WORKER_ENV');
