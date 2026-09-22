import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Local runs read the root .env (TEST_DATABASE_ADMIN_URL, TEST_REDIS_URL); CI provides the same file.
const rootEnv = path.resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return value;
};

// Dedicated ports so a running `pnpm dev` (3000/4000) is never reused by mistake.
export const E2E_WEB_ORIGIN = 'http://127.0.0.1:3100';
export const E2E_API_URL = 'http://127.0.0.1:4100';

function e2eDatabaseUrl(): string {
  const url = new URL(required('TEST_DATABASE_ADMIN_URL'));
  url.pathname = '/hv_e2e';
  return url.toString();
}

/** A Redis logical database of its own (14), emptied by e2e:prepare before every run. */
function e2eRedisUrl(): string {
  const url = new URL(required('TEST_REDIS_URL'));
  url.pathname = '/14';
  return url.toString();
}

/**
 * The e2e API env, shared with the setup project (which runs the operator CLI).
 * DE is listed in ENABLED_MARKETS on purpose: the database gate alone must keep it closed.
 */
export const E2E_API_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  API_HOST: '127.0.0.1',
  API_PORT: '4100',
  DATABASE_URL: e2eDatabaseUrl(),
  REDIS_URL: e2eRedisUrl(),
  ENABLED_MARKETS: 'uk,ie,de',
  WEB_ORIGINS: E2E_WEB_ORIGIN,
  SESSION_COOKIE_SECURE: 'false',
  MFA_ENCRYPTION_KEY: '0'.repeat(64),
} as const;

// Smoke tests run against the production builds (`pnpm build` must have run first).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Every request goes through the real API (Argon2id hashing, PostgreSQL, Redis); more
  // workers than this only queue behind each other and push slow steps past the timeout.
  workers: 3,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: E2E_WEB_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      // The customer journey again on a phone-sized viewport.
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /(^|[\\/])draws\.spec\.ts$/,
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      // Recreates the hv_e2e database from the migrations, then starts the built API on it.
      command: 'pnpm --filter @hv/db e2e:prepare && node ../api/dist/main.js',
      url: `${E2E_API_URL}/health/ready`,
      env: E2E_API_ENV,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec next start -H 127.0.0.1 -p 3100',
      url: E2E_WEB_ORIGIN,
      env: { NODE_ENV: 'production', API_BASE_URL: E2E_API_URL },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
