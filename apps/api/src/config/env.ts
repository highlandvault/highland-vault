import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Validated API environment. Startup fails fast on anything missing or malformed. */
export const ApiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
  REDIS_URL: z.url().refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

export function parseApiEnv(source: NodeJS.ProcessEnv): ApiEnv {
  const result = ApiEnvSchema.safeParse(source);
  if (!result.success) {
    // Report variable names and reasons only — never echo values (they may be secrets).
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid API environment:\n${details}`);
  }
  return result.data;
}

export const API_ENV = Symbol('API_ENV');
