/**
 * Creates the staff accounts for the admin tests the way operators do:
 * register through the API, then grant the role with the operator CLI
 * (apps/api/dist/cli/grant-role.js) against the e2e database.
 *
 *   support — admin shell, reads draws, cannot change them
 *   admin   — manages draws (draws.write); no MFA needed, draws are not a sensitive operation
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, test as setup } from '@playwright/test';
import { E2E_API_ENV, E2E_API_URL, E2E_WEB_ORIGIN } from '../playwright.config';
import { ADMIN_EMAIL_FILE, PASSWORD, STAFF_EMAIL_FILE, uniqueEmail } from './fixtures';

async function staffAccount(request: APIRequestContext, role: string, file: string) {
  const email = uniqueEmail(role);
  const response = await request.post(`${E2E_API_URL}/auth/register`, {
    headers: { origin: E2E_WEB_ORIGIN },
    data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(201);

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

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, email);
}

setup('create the staff accounts', async ({ request }) => {
  await staffAccount(request, 'support', STAFF_EMAIL_FILE);
  await staffAccount(request, 'admin', ADMIN_EMAIL_FILE);
});
