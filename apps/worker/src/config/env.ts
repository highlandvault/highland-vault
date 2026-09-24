import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Validated worker environment. Startup fails fast on anything missing or malformed. */
export const WorkerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
    REDIS_URL: z
      .url()
      .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),

    // Mail (ADR-0028). Optional here so development and the existing tests run
    // without it; production requires it (below), because a production worker
    // that cannot send mail would leave verification events failing silently.
    SMTP_URL: z
      .string()
      .regex(/^smtps?:\/\//, 'must be an smtp:// or smtps:// URL')
      .optional(),
    MAIL_FROM: z.email().optional(),

    // AES-256-GCM key for sensitive outbox payloads: 64 hex characters (32
    // bytes). Separate from MFA_ENCRYPTION_KEY — same construction, different
    // purpose, so one key never unlocks the other's data.
    OUTBOX_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters')
      .optional(),
    OUTBOX_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default('k1'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Fail closed: a production worker without mail configuration would accept
    // verification events it can never deliver. O14 has not chosen a provider,
    // so this is the gate that stops it shipping unnoticed.
    for (const key of ['SMTP_URL', 'MAIL_FROM', 'OUTBOX_ENCRYPTION_KEY'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
      }
    }
    if (env.OUTBOX_ENCRYPTION_KEY && /^(..)\1+$/.test(env.OUTBOX_ENCRYPTION_KEY.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOX_ENCRYPTION_KEY'],
        message: 'must not be a repeated placeholder value',
      });
    }
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
