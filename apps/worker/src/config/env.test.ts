import { describe, expect, it } from 'vitest';
import { parseWorkerEnv } from './env';

const BASE = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
};
const KEY = '4f8b2c19a07d3e56b1c48a29f70d6e35c92a1b84de07f63a5c18e40b9d2f7a61';
const MAIL = { SMTP_URL: 'smtp://127.0.0.1:1025', MAIL_FROM: 'no-reply@example.com' };

describe('worker environment', () => {
  it('runs without mail configuration outside production', () => {
    const env = parseWorkerEnv({ ...BASE });
    expect(env.SMTP_URL).toBeUndefined();
    expect(env.OUTBOX_ENCRYPTION_KEY_ID).toBe('k1');
  });

  it('accepts mail configuration', () => {
    const env = parseWorkerEnv({
      ...BASE,
      ...MAIL,
      OUTBOX_ENCRYPTION_KEY: KEY,
    });
    expect(env.MAIL_FROM).toBe('no-reply@example.com');
  });

  it('fails closed in production when mail is not configured', () => {
    // A production worker without mail would accept verification events it can
    // never deliver (ADR-0028). O14 has not chosen a provider, so this is the
    // gate that stops that shipping unnoticed.
    const attempt = () => parseWorkerEnv({ ...BASE, NODE_ENV: 'production' });
    expect(attempt).toThrow(/SMTP_URL/);
    expect(attempt).toThrow(/MAIL_FROM/);
    expect(attempt).toThrow(/OUTBOX_ENCRYPTION_KEY/);
  });

  it('refuses a placeholder encryption key in production', () => {
    expect(() =>
      parseWorkerEnv({
        ...BASE,
        ...MAIL,
        NODE_ENV: 'production',
        OUTBOX_ENCRYPTION_KEY: 'ab'.repeat(32),
      }),
    ).toThrow(/repeated placeholder/);
  });

  it('rejects a malformed SMTP URL or key', () => {
    expect(() => parseWorkerEnv({ ...BASE, SMTP_URL: 'http://127.0.0.1' })).toThrow(/smtp/);
    expect(() => parseWorkerEnv({ ...BASE, OUTBOX_ENCRYPTION_KEY: 'short' })).toThrow(/64 hex/);
  });

  it('names variables without echoing their values', () => {
    try {
      parseWorkerEnv({ ...BASE, OUTBOX_ENCRYPTION_KEY: 'secret-ish-value' });
      throw new Error('expected the parse to fail');
    } catch (error) {
      expect((error as Error).message).toContain('OUTBOX_ENCRYPTION_KEY');
      expect((error as Error).message).not.toContain('secret-ish-value');
    }
  });
});
