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

    // The API seals sensitive outbox payloads and the worker opens them, so
    // both must hold the same key (ADR-0028). Separate from MFA_ENCRYPTION_KEY:
    // same construction, different purpose.
    OUTBOX_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
    OUTBOX_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default('k1'),

    // Ticket reservation lifetime. D11 fixes it at 10 minutes (600 s); shorter
    // values exist only so automated tests can observe expiry, and are refused
    // in production.
    RESERVATION_TTL_SECONDS: z.coerce.number().int().min(2).max(600).default(600),
    SESSION_COOKIE_SECURE: booleanString.default(true),

    // ---- the payment window (Phase 6, D1 = B, D1a, D1b, D3a) --------------
    //
    // Three values that together decide how long a customer has to pay. They
    // are configurable for the same reason RESERVATION_TTL_SECONDS is: the
    // test suite runs holds of two and six seconds to observe expiry, and with
    // the production margin and floor no payment could ever be started there.
    // Production is pinned to the locked values below.

    /** The intended payment window. In practice the margin term always binds first. */
    PAYMENT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(600),
    /**
     * How far before its hold expires an order's deadline lands (D1a).
     *
     * This is exactly how much provider lag is absorbed: a customer who pays a
     * second before the deadline is still served if the provider confirms
     * within this long. It is also what lets `hv_expire_reservations` stay
     * untouched (D11a = B), so lowering it is not a local change.
     */
    PAYMENT_MARGIN_SECONDS: z.coerce.number().int().min(1).max(600).default(90),
    /** Below this much time left, starting a payment is refused rather than begun (D1b). */
    PAYMENT_MIN_WINDOW_SECONDS: z.coerce.number().int().min(1).max(600).default(180),
    /** How long one attempt may wait on the provider before it is finished (D3a). */
    PAYMENT_ATTEMPT_TTL_SECONDS: z.coerce.number().int().min(1).max(600).default(120),

    /**
     * The fake provider's webhook signing key (ADR-0006).
     *
     * Optional, and refused outright in production: there is no production
     * payment provider yet (O13), so a production deployment simply has none
     * and payment initiation fails closed. Setting one would be the only way
     * to get a fake provider into production, and the guard below forbids it.
     */
    FAKE_PAYMENT_WEBHOOK_SECRET: z.string().min(16).max(256).optional(),

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
    // The payment window is a locked owner decision, not a tuning knob. The
    // shorter values exist for tests that need to watch a hold run out.
    const pinned = [
      ['PAYMENT_WINDOW_SECONDS', env.PAYMENT_WINDOW_SECONDS, 600, 'D1'],
      ['PAYMENT_MARGIN_SECONDS', env.PAYMENT_MARGIN_SECONDS, 90, 'D1a'],
      ['PAYMENT_MIN_WINDOW_SECONDS', env.PAYMENT_MIN_WINDOW_SECONDS, 180, 'D1b'],
      ['PAYMENT_ATTEMPT_TTL_SECONDS', env.PAYMENT_ATTEMPT_TTL_SECONDS, 120, 'D3a'],
    ] as const;
    for (const [name, actual, expected, decision] of pinned) {
      if (actual !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `must be ${expected} (${decision}) in production`,
        });
      }
    }
    // The fake provider refuses to exist in production on its own (its
    // constructor throws), so a secret here could only be a misunderstanding.
    // Failing at startup says so, instead of leaving an unused setting that
    // looks like it configured something.
    if (env.FAKE_PAYMENT_WEBHOOK_SECRET !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['FAKE_PAYMENT_WEBHOOK_SECRET'],
        message: 'must not be set in production: there is no fake payment provider there',
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
    // The same guard the worker applies (apps/worker/src/config/env.ts). The
    // API became a holder of this key in P5-4, when it started sealing
    // verification codes; a placeholder here would seal them to nothing.
    if (/^(..)\1+$/.test(env.OUTBOX_ENCRYPTION_KEY.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOX_ENCRYPTION_KEY'],
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
