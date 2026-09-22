/**
 * API health endpoints against the real PostgreSQL and Redis containers.
 * Requests go through Fastify's in-process injector (no open port needed).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LivenessResponseSchema, ReadinessResponseSchema } from '@hv/contracts';
import { createTestDatabase, type TestDatabase } from '@hv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEV_PLACEHOLDER_MFA_KEY, parseApiEnv } from '../src/config/env';

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

async function start(overrides: Record<string, string>, database: TestDatabase) {
  const env = parseApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    REDIS_URL: testRedisUrl(),
    ENABLED_MARKETS: 'uk,ie',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    MFA_ENCRYPTION_KEY: DEV_PLACEHOLDER_MFA_KEY,
    ...overrides,
  });
  const app = await createApp(env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('API health', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  describe('with PostgreSQL and Redis available', () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await start({}, database);
    });
    afterAll(async () => {
      await app?.close();
    });

    it('GET /health/live returns 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(LivenessResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
    });

    it('GET /health/ready returns 200 with both dependencies up', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = ReadinessResponseSchema.parse(response.json());
      expect(body.status).toBe('ok');
      expect(body.checks.database.status).toBe('up');
      expect(body.checks.redis.status).toBe('up');
    });

    it('propagates a supplied x-request-id and echoes it on the response', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'support-trace-123' },
      });
      expect(response.headers['x-request-id']).toBe('support-trace-123');
    });

    it('generates a UUID request id when none (or an oversized one) is supplied', async () => {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const none = await app.inject({ method: 'GET', url: '/health/live' });
      expect(none.headers['x-request-id']).toMatch(uuid);
      const oversized = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'x'.repeat(129) },
      });
      expect(oversized.headers['x-request-id']).toMatch(uuid);
    });

    it('returns 404 for unknown routes (no draw endpoints exist yet)', async () => {
      const response = await app.inject({ method: 'GET', url: '/draws' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });
  });

  describe('with Redis unreachable', () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      // Port 1 on loopback: nothing listens there, connections are refused immediately.
      app = await start({ REDIS_URL: 'redis://127.0.0.1:1/0' }, database);
    });
    afterAll(async () => {
      await app?.close();
    });

    it('GET /health/live still returns 200 (process is alive)', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    });

    it('GET /health/ready returns 503 and names the failing dependency', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      const body = ReadinessResponseSchema.parse(response.json());
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.status).toBe('up');
      expect(body.checks.redis.status).toBe('down');
    });
  });

  describe('with PostgreSQL unreachable', () => {
    let app: NestFastifyApplication;
    beforeAll(async () => {
      app = await start({ DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/none' }, database);
    });
    afterAll(async () => {
      await app?.close();
    });

    it('GET /health/ready returns 503 with the database down', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      const body = ReadinessResponseSchema.parse(response.json());
      expect(body.checks.database.status).toBe('down');
      expect(body.checks.redis.status).toBe('up');
    });
  });
});
