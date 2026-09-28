import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEV_PLACEHOLDER_INTERNAL_TOKEN,
  DEV_PLACEHOLDER_MFA_KEY,
  EnvValidationError,
  parseApiEnv,
} from './env';

const valid = {
  DATABASE_URL: 'postgres://hv_app:secret@127.0.0.1:5432/highland_vault',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  ENABLED_MARKETS: 'uk,ie',
  WEB_ORIGINS: 'http://127.0.0.1:3000',
  MFA_ENCRYPTION_KEY: DEV_PLACEHOLDER_MFA_KEY,
  // Required since P5-4: the API seals verification codes with it, so a boot
  // without it would only fail later, one request at a time.
  OUTBOX_ENCRYPTION_KEY: '0'.repeat(64),
  // Required since P6-5: the internal listener will not open without it, and
  // a boot that skipped it would leave the reconciler unable to reach the API.
  INTERNAL_API_TOKEN: DEV_PLACEHOLDER_INTERNAL_TOKEN,
};

const production = {
  ...valid,
  NODE_ENV: 'production',
  WEB_ORIGINS: 'https://www.example.com',
  // Generated per run: no key-like literal ever lands in the repository.
  MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  OUTBOX_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  INTERNAL_API_TOKEN: randomBytes(24).toString('hex'),
};

describe('parseApiEnv', () => {
  it('applies defaults for optional values', () => {
    const env = parseApiEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      SESSION_TTL_HOURS: 168,
      RESERVATION_TTL_SECONDS: 600,
      SESSION_COOKIE_SECURE: true,
      MFA_ENCRYPTION_KEY_ID: 'k1',
      TRUST_PROXY: [],
      WEB_ORIGINS: ['http://127.0.0.1:3000'],
    });
    expect([...env.ENABLED_MARKETS]).toEqual(['uk', 'ie']);
  });

  it('coerces the port', () => {
    expect(parseApiEnv({ ...valid, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('fails fast when required variables are missing', () => {
    expect(() => parseApiEnv({})).toThrow(EnvValidationError);
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'ENABLED_MARKETS',
      'WEB_ORIGINS',
      'MFA_ENCRYPTION_KEY',
      'OUTBOX_ENCRYPTION_KEY',
    ]) {
      expect(() => parseApiEnv({})).toThrow(new RegExp(name));
    }
  });

  it('rejects wrong URL schemes and never echoes values', () => {
    const attempt = () => parseApiEnv({ ...valid, DATABASE_URL: 'mysql://user:topsecret@host/db' });
    expect(attempt).toThrow(/DATABASE_URL: must be a postgres/);
    expect(attempt).not.toThrow(/topsecret/);
  });

  it('rejects unknown log levels and bad ports', () => {
    expect(() => parseApiEnv({ ...valid, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => parseApiEnv({ ...valid, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  describe('ENABLED_MARKETS (market gate layer 2)', () => {
    it('accepts an empty list: no market is available', () => {
      expect(parseApiEnv({ ...valid, ENABLED_MARKETS: '' }).ENABLED_MARKETS.size).toBe(0);
    });

    it('rejects unknown market codes', () => {
      expect(() => parseApiEnv({ ...valid, ENABLED_MARKETS: 'uk,fr' })).toThrow(
        /ENABLED_MARKETS: Unknown market code "fr"/,
      );
    });
  });

  it('rejects origins with a path and malformed MFA keys', () => {
    expect(() => parseApiEnv({ ...valid, WEB_ORIGINS: 'http://127.0.0.1:3000/app' })).toThrow(
      /WEB_ORIGINS/,
    );
    expect(() => parseApiEnv({ ...valid, MFA_ENCRYPTION_KEY: 'abc' })).toThrow(
      /MFA_ENCRYPTION_KEY: must be 64 hex/,
    );
  });

  describe('production refuses development shortcuts', () => {
    it('accepts a proper production configuration', () => {
      expect(parseApiEnv(production).NODE_ENV).toBe('production');
    });

    it('refuses insecure session cookies', () => {
      expect(() => parseApiEnv({ ...production, SESSION_COOKIE_SECURE: 'false' })).toThrow(
        /SESSION_COOKIE_SECURE: must be true in production/,
      );
    });

    it('refuses a reservation lifetime other than 10 minutes', () => {
      expect(() => parseApiEnv({ ...production, RESERVATION_TTL_SECONDS: '60' })).toThrow(
        /RESERVATION_TTL_SECONDS: must be 600/,
      );
    });

    it('pins every value of the payment window', () => {
      // Locked owner decisions, not tuning knobs. The shorter values exist so
      // tests can watch a hold run out; production gets the decided ones.
      expect(() => parseApiEnv({ ...production, PAYMENT_WINDOW_SECONDS: '900' })).toThrow(
        /PAYMENT_WINDOW_SECONDS: must be 600 \(D1\)/,
      );
      expect(() => parseApiEnv({ ...production, PAYMENT_MARGIN_SECONDS: '30' })).toThrow(
        /PAYMENT_MARGIN_SECONDS: must be 90 \(D1a\)/,
      );
      expect(() => parseApiEnv({ ...production, PAYMENT_MIN_WINDOW_SECONDS: '60' })).toThrow(
        /PAYMENT_MIN_WINDOW_SECONDS: must be 180 \(D1b\)/,
      );
      expect(() => parseApiEnv({ ...production, PAYMENT_ATTEMPT_TTL_SECONDS: '300' })).toThrow(
        /PAYMENT_ATTEMPT_TTL_SECONDS: must be 120 \(D3a\)/,
      );
    });

    it('refuses a fake payment provider', () => {
      // There is no fake provider in production and no chosen one either
      // (O13). A secret here could only be a misunderstanding, so startup says
      // so rather than leaving a setting that looks like it configured
      // something.
      expect(() =>
        parseApiEnv({ ...production, FAKE_PAYMENT_WEBHOOK_SECRET: 'x'.repeat(32) }),
      ).toThrow(/FAKE_PAYMENT_WEBHOOK_SECRET: must not be set in production/);
    });

    it('refuses a placeholder internal-listener token (K-a)', () => {
      // The token is the credential on the internal reconciliation route. A
      // placeholder that ships in .env.example is a secret everybody has, so
      // production refuses it the way it refuses the MFA key's placeholder.
      expect(() =>
        parseApiEnv({ ...production, INTERNAL_API_TOKEN: DEV_PLACEHOLDER_INTERNAL_TOKEN }),
      ).toThrow(/INTERNAL_API_TOKEN: must be a real random secret in production/);
      // 32 bytes of nothing is long enough for the schema and still not a secret.
      expect(() => parseApiEnv({ ...production, INTERNAL_API_TOKEN: 'ab'.repeat(20) })).toThrow(
        /INTERNAL_API_TOKEN: must be a real random secret in production/,
      );
    });

    it('requires an internal-listener token of at least 32 bytes', () => {
      const { INTERNAL_API_TOKEN: _omitted, ...without } = production;
      expect(() => parseApiEnv(without)).toThrow(/INTERNAL_API_TOKEN/);
      expect(() => parseApiEnv({ ...production, INTERNAL_API_TOKEN: 'short' })).toThrow(
        /INTERNAL_API_TOKEN/,
      );
    });

    it('refuses an ephemeral internal port in production', () => {
      // Port 0 asks the operating system for whatever is free, which is a
      // testing convenience. A worker has to be told a fixed one.
      expect(() => parseApiEnv({ ...production, INTERNAL_API_PORT: '0' })).toThrow(
        /INTERNAL_API_PORT: must be a fixed port in production/,
      );
    });

    it('defaults the internal listener to loopback', () => {
      // The network boundary belongs to the deployment; the default must not
      // quietly expose the port if nobody sets one.
      expect(parseApiEnv(production)).toMatchObject({
        INTERNAL_API_HOST: '127.0.0.1',
        INTERNAL_API_PORT: 4001,
      });
    });

    it('accepts the locked payment values', () => {
      const env = parseApiEnv(production);
      expect(env).toMatchObject({
        PAYMENT_WINDOW_SECONDS: 600,
        PAYMENT_MARGIN_SECONDS: 90,
        PAYMENT_MIN_WINDOW_SECONDS: 180,
        PAYMENT_ATTEMPT_TTL_SECONDS: 120,
      });
      expect(env.FAKE_PAYMENT_WEBHOOK_SECRET).toBeUndefined();
    });

    it('refuses plain-http origins', () => {
      expect(() => parseApiEnv({ ...production, WEB_ORIGINS: 'http://www.example.com' })).toThrow(
        /WEB_ORIGINS: must all be https/,
      );
    });

    it('refuses the placeholder MFA key and repeated-byte keys', () => {
      expect(() =>
        parseApiEnv({ ...production, MFA_ENCRYPTION_KEY: DEV_PLACEHOLDER_MFA_KEY }),
      ).toThrow(/MFA_ENCRYPTION_KEY: must be a real random key/);
      expect(() => parseApiEnv({ ...production, MFA_ENCRYPTION_KEY: 'ab'.repeat(32) })).toThrow(
        /MFA_ENCRYPTION_KEY/,
      );
    });

    it('refuses a placeholder outbox key, as the worker does', () => {
      // The two must agree: the API seals with this key and the worker opens
      // with it, so a guard on one side only would leave a real gap.
      expect(() => parseApiEnv({ ...production, OUTBOX_ENCRYPTION_KEY: '0'.repeat(64) })).toThrow(
        /OUTBOX_ENCRYPTION_KEY: must be a real random key/,
      );
      expect(() => parseApiEnv({ ...production, OUTBOX_ENCRYPTION_KEY: 'ab'.repeat(32) })).toThrow(
        /OUTBOX_ENCRYPTION_KEY/,
      );
    });

    it('rejects a malformed outbox key without echoing it', () => {
      const attempt = () => parseApiEnv({ ...valid, OUTBOX_ENCRYPTION_KEY: 'nothex' });
      expect(attempt).toThrow(/OUTBOX_ENCRYPTION_KEY: must be 64 hex/);
      expect(attempt).not.toThrow(/nothex/);
    });
  });
});
