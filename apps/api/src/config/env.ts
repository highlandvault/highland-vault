import { type MarketCode, parseEnabledMarkets } from '@hv/domain';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** The local-development placeholder in .env.example. Refused in production. */
export const DEV_PLACEHOLDER_MFA_KEY = '0'.repeat(64);

const booleanString = z
  .enum(['true', 'false'], { message: 'must be "true" or "false"' })
  .transform((value) => value === 'true');

const commaList = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** Validated API environment. Startup fails fast on anything missing or malformed. */
export const ApiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// URL'),
    REDIS_URL: z
      .url()
      .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),

    // Market gate, layer 2 (ADR-0005): the API refuses any market not listed,
    // whatever the database says. Required, so every environment decides explicitly.
    ENABLED_MARKETS: z.string().transform((value, ctx): ReadonlySet<MarketCode> => {
      try {
        return parseEnabledMarkets(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    }),

    // Browser origins allowed to send state-changing requests (CSRF origin check).
    WEB_ORIGINS: z
      .string()
      .transform(commaList)
      .pipe(
        z
          .array(z.url().refine((v) => new URL(v).origin === v, 'must be an origin without a path'))
          .min(1),
      ),

    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),

    // Guest checkout (ADR-0029). A guest session lasts a day: long enough to
    // finish a checkout and come back to it, short enough that an abandoned
    // browser does not carry an identity around for a week.
    GUEST_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    // How long a verified email stays usable (ADR-0020). Deliberately much
    // shorter than the session: proving you can read an inbox should not be
    // good for the rest of the day.
    GUEST_VERIFIED_EMAIL_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

    // Ticket reservation lifetime. D11 fixes it at 10 minutes (600 s); shorter
    // values exist only so automated tests can observe expiry, and are refused
    // in production.
    RESERVATION_TTL_SECONDS: z.coerce.number().int().min(2).max(600).default(600),
    SESSION_COOKIE_SECURE: booleanString.default(true),

    // AES-256-GCM key for TOTP secrets: 64 hex characters (32 bytes).
    MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
    MFA_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default('k1'),

    // Proxy addresses/CIDRs whose X-Forwarded-For is trusted. Empty = trust nobody.
    TRUST_PROXY: z.string().default('').transform(commaList),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // No development shortcuts in production.
    if (!env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (env.WEB_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGINS'],
        message: 'must all be https:// in production',
      });
    }
    if (env.RESERVATION_TTL_SECONDS !== 600) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESERVATION_TTL_SECONDS'],
        message: 'must be 600 (10 minutes, D11) in production',
      });
    }
    const key = env.MFA_ENCRYPTION_KEY.toLowerCase();
    if (key === DEV_PLACEHOLDER_MFA_KEY || /^(..)\1+$/.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'must be a real random key in production, not the placeholder',
      });
    }
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
