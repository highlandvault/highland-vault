/**
 * Shared harness for API integration tests: a real NestJS app on a throwaway
 * PostgreSQL database and the real Redis test DB, driven through Fastify's
 * in-process injector. Nothing is mocked.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@hv/db/testing';
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app';
import { base32Decode, hotp, totpStep } from '../src/auth/totp';
import { DEV_PLACEHOLDER_MFA_KEY, parseApiEnv } from '../src/config/env';

export const WEB_ORIGIN = 'http://127.0.0.1:3000';
export const PASSWORD = 'correct horse battery staple';

export function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

export interface Harness {
  app: NestFastifyApplication;
  database: TestDatabase;
  /** Owner-role connection for arranging state and asserting on rows. */
  sql: pg.Pool;
  close(): Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const database = await createTestDatabase();
  const app = await startApp(database, env);
  const sql = new pg.Pool({ connectionString: database.url, max: 4 });
  return {
    app,
    database,
    sql,
    close: async () => {
      await app.close();
      await sql.end();
      await database.drop();
    },
  };
}

export async function startApp(
  database: TestDatabase,
  overrides: Record<string, string> = {},
): Promise<NestFastifyApplication> {
  const env = parseApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    REDIS_URL: testRedisUrl(),
    ENABLED_MARKETS: 'uk,ie',
    WEB_ORIGINS: WEB_ORIGIN,
    SESSION_COOKIE_SECURE: 'false',
    MFA_ENCRYPTION_KEY: DEV_PLACEHOLDER_MFA_KEY,
    // The API seals outbox payloads (ADR-0028); a low-entropy placeholder,
    // the same convention as the MFA key above.
    OUTBOX_ENCRYPTION_KEY: '0'.repeat(64),
    ...overrides,
  });
  const app = await createApp(env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/**
 * A random client address per test client, so rate-limit counters (keyed by IP
 * in the shared Redis test DB) never collide across tests or repeated runs.
 */
export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomInt(1e9).toString(36)}@example.com`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A browser-like client: remembers its session cookie and sends the allowed Origin. */
export class Client {
  cookie: string | null = null;
  readonly ip = randomIp();

  constructor(private readonly app: NestFastifyApplication) {}

  async request(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        origin: WEB_ORIGIN,
        ...(this.cookie ? { cookie: `hv_session=${this.cookie}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    const setCookie = response.headers['set-cookie'];
    const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = value ? /^hv_session=([^;]*)/.exec(value) : null;
    if (match) this.cookie = match[1] || null;
    return response;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, undefined, headers);
  }

  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, body ?? {}, headers);
  }

  put(url: string, body?: unknown) {
    return this.request('PUT', url, body ?? {});
  }
}

/** Registers a new account and returns a signed-in client. */
export async function registeredClient(
  app: NestFastifyApplication,
  email = uniqueEmail('user'),
): Promise<Client & { email: string }> {
  const client = Object.assign(new Client(app), { email });
  const response = await client.post('/auth/register', { email, password: PASSWORD });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  return client;
}

export async function grantRole(
  sql: pg.Pool,
  email: string,
  role: string,
  market: string | null = null,
): Promise<void> {
  await sql.query(
    `INSERT INTO user_roles (user_id, role_code, market_id)
     SELECT u.id, $2, (SELECT id FROM markets WHERE code = $3) FROM users u WHERE u.email = $1`,
    [email, role, market],
  );
}

/**
 * Authenticator-app stand-in: produces codes the way a phone would. Each call
 * returns a code for a later time step than the previous one (the API rejects
 * replays), using the ±1 step drift window.
 */
export class Authenticator {
  private lastStep: number | null = null;

  constructor(readonly secret: Buffer) {}

  next(): string {
    const current = totpStep(Date.now());
    const step = this.lastStep === null ? current : Math.max(this.lastStep + 1, current);
    if (step > current + 1) throw new Error('authenticator exhausted for this 30s window');
    this.lastStep = step;
    return hotp(this.secret, step);
  }
}

/** Enrols TOTP for a signed-in client; returns its authenticator and recovery codes. */
export async function enrolMfa(client: Client) {
  const setup = await client.post('/auth/mfa/totp/setup');
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.body}`);
  const { secret } = setup.json<{ secret: string }>();
  const authenticator = new Authenticator(base32Decode(secret));
  const confirm = await client.post('/auth/mfa/totp/confirm', { code: authenticator.next() });
  if (confirm.statusCode !== 200) throw new Error(`confirm failed: ${confirm.body}`);
  return {
    authenticator,
    recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes,
  };
}
