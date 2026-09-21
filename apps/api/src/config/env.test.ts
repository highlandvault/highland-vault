import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseApiEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://hv_app:secret@127.0.0.1:5432/highland_vault',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
};

describe('parseApiEnv', () => {
  it('applies defaults for optional values', () => {
    expect(parseApiEnv(valid)).toEqual({
      ...valid,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
    });
  });

  it('coerces the port', () => {
    expect(parseApiEnv({ ...valid, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('fails fast when required variables are missing', () => {
    expect(() => parseApiEnv({})).toThrow(EnvValidationError);
    expect(() => parseApiEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseApiEnv({})).toThrow(/REDIS_URL/);
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
});
