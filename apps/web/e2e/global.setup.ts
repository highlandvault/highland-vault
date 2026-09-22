/**
 * Creates the staff account for the admin-shell tests the way operators do:
 * register through the API, then grant the role with the operator CLI
 * (apps/api/dist/cli/grant-role.js) against the e2e database.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { E2E_API_ENV, E2E_API_URL, E2E_WEB_ORIGIN } from '../playwright.config';
import { PASSWORD, STAFF_EMAIL_FILE, uniqueEmail } from './fixtures';

setup('create a support staff account', async ({ request }) => {
  const email = uniqueEmail('staff');
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
      'support',
      '--reason',
      'e2e fixture staff account',
    ],
    { env: { ...process.env, ...E2E_API_ENV }, encoding: 'utf8' },
  );
  expect(output).toContain(`granted support to ${email}`);

  mkdirSync(path.dirname(STAFF_EMAIL_FILE), { recursive: true });
  writeFileSync(STAFF_EMAIL_FILE, email);
});
