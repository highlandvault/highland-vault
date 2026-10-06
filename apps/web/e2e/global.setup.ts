/**
 * Creates the staff accounts for the admin tests the way operators do:
 * register through the API, then grant the role with the operator CLI
 * (apps/api/dist/cli/grant-role.js) against the e2e database.
 *
 *   support     — admin shell, reads draws, cannot change them
 *   admin       — manages draws (draws.write); no MFA needed, draws are not a sensitive operation
 *   super_admin — market gate operations (UI-10), with a second factor enrolled
 *
 * The third one is different in two ways, both deliberate. Its **user row is
 * seeded by `e2e:prepare`** rather than registered here, because a full suite
 * run already spends all twenty registrations an hour the API allows one
 * address; only its role and its second factor are arranged over the API. And
 * it is the **only** fixture account with MFA — the other two are signed into
 * by the auth and draw specs expecting a single step, so enrolling either
 * would break them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, test as setup } from '@playwright/test';
import {
  E2E_API_ENV,
  E2E_API_URL,
  E2E_NO_MFA_STAFF_EMAIL,
  E2E_STAFF_FIXTURE_EMAIL,
  E2E_STAFF_FIXTURE_PASSWORD,
  E2E_WEB_ORIGIN,
} from '../playwright.config';
import {
  ADMIN_EMAIL_FILE,
  NO_MFA_ADMIN_EMAIL_FILE,
  PASSWORD,
  STAFF_EMAIL_FILE,
  SUPER_ADMIN_EMAIL_FILE,
  SUPER_ADMIN_TOTP_FILE,
  totpNow,
  uniqueEmail,
} from './fixtures';

/** The operator CLI, exactly as `staffAccount` has always used it. */
function grantRole(email: string, role: string): void {
  const output = execFileSync(
    process.execPath,
    [
      path.resolve(__dirname, '../../api/dist/cli/grant-role.js'),
      '--email',
      email,
      '--role',
      role,
      '--reason',
      `e2e fixture ${role} account`,
    ],
    { env: { ...process.env, ...E2E_API_ENV }, encoding: 'utf8' },
  );
  expect(output).toContain(`granted ${role} to ${email}`);
}

function write(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}

async function staffAccount(request: APIRequestContext, role: string, file: string) {
  const email = uniqueEmail(role);
  const response = await request.post(`${E2E_API_URL}/auth/register`, {
    headers: { origin: E2E_WEB_ORIGIN },
    data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(201);
  grantRole(email, role);
  write(file, email);
}

/**
 * The super_admin the market tests use: role granted, second factor enrolled.
 *
 * Its user row already exists — `e2e:prepare` seeded it — so this signs in
 * with the fixture password and uses the real enrolment routes. No
 * registration is consumed; `loginPerEmail` allows ten sign-ins a quarter-hour
 * and `mfaPerUser` five confirmations, against the one of each used here.
 *
 * The TOTP secret is written to `test-results/` (gitignored) because the tests
 * have to produce a current code at step-up time. It is a throwaway credential
 * for a throwaway account in a throwaway database, and it is never printed.
 */
async function superAdminWithMfa(request: APIRequestContext) {
  const email = E2E_STAFF_FIXTURE_EMAIL;
  grantRole(email, 'super_admin');

  const signIn = await request.post(`${E2E_API_URL}/auth/login`, {
    headers: { origin: E2E_WEB_ORIGIN },
    data: { email, password: E2E_STAFF_FIXTURE_PASSWORD },
  });
  // If this fails, the seeded password hash and the API's hashing have drifted
  // apart — which is exactly the loud failure the fixture comment promises.
  expect(signIn.status(), 'the seeded staff fixture can sign in').toBe(200);
  const cookie = (signIn.headers()['set-cookie'] ?? '').split(';')[0] ?? '';
  expect(cookie, 'sign-in issued a session').toContain('hv_session=');

  const setupResponse = await request.post(`${E2E_API_URL}/auth/mfa/totp/setup`, {
    headers: { origin: E2E_WEB_ORIGIN, cookie },
  });
  expect(setupResponse.status()).toBe(200);
  const { secret } = (await setupResponse.json()) as { secret: string };

  const confirm = await request.post(`${E2E_API_URL}/auth/mfa/totp/confirm`, {
    headers: { origin: E2E_WEB_ORIGIN, cookie },
    data: { code: totpNow(secret) },
  });
  expect(confirm.status(), 'the fixture enrolled its second factor').toBe(200);

  write(SUPER_ADMIN_EMAIL_FILE, email);
  write(SUPER_ADMIN_TOTP_FILE, secret);
}

/**
 * The same authority, no second factor.
 *
 * Only the role is granted: nothing enrols it, which is the point. With
 * `markets.gate.manage` and no factor at all, every sensitive route answers
 * `STEP_UP_REQUIRED` on the first try, so the browser can be shown doing the
 * right thing with it.
 */
function superAdminWithoutMfa() {
  grantRole(E2E_NO_MFA_STAFF_EMAIL, 'super_admin');
  write(NO_MFA_ADMIN_EMAIL_FILE, E2E_NO_MFA_STAFF_EMAIL);
}

setup('create the staff accounts', async ({ request }) => {
  await staffAccount(request, 'support', STAFF_EMAIL_FILE);
  await staffAccount(request, 'admin', ADMIN_EMAIL_FILE);
  await superAdminWithMfa(request);
  superAdminWithoutMfa();
});
