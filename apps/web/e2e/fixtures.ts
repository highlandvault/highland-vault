import { createHmac, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

/** Staff accounts created by global.setup.ts. */
export const STAFF_EMAIL_FILE = 'test-results/.e2e-staff-email'; // support role
export const ADMIN_EMAIL_FILE = 'test-results/.e2e-admin-email'; // admin role (draws.write)
/**
 * The super_admin used by the market operations tests (UI-10), and its TOTP
 * secret — written by global.setup.ts because the tests need a current code to
 * satisfy step-up. `test-results/` is gitignored; neither value is ever
 * printed by a test.
 */
export const SUPER_ADMIN_EMAIL_FILE = 'test-results/.e2e-super-admin-email';
export const SUPER_ADMIN_TOTP_FILE = 'test-results/.e2e-super-admin-totp';
/** A super_admin with no second factor, for the step-up refusal path. */
export const NO_MFA_ADMIN_EMAIL_FILE = 'test-results/.e2e-nomfa-admin-email';

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomInt(1e9).toString(36)}@example.com`;
}

export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Registers a fresh customer account; the page is then signed in as it. */
export async function registerCustomer(page: Page, label = 'customer'): Promise<string> {
  const email = uniqueEmail(label);
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/account$/);
  return email;
}

/* ------------------------------------------------------- authenticator app
 *
 * A TOTP generator for the MFA enrolment test (UI-9), standing in for the
 * phone a customer would hold.
 *
 * **This intentionally mirrors `apps/api/src/auth/totp.ts`** — the same base32
 * alphabet, the same HMAC-SHA1 over a big-endian counter, the same 30-second
 * period and 6 digits — and it exists only to generate codes for a browser
 * test. It is written here rather than imported because `apps/web` does not
 * depend on `@hv/api`, and **adding an application dependency purely to
 * generate a test fixture is deliberately avoided**: it would be a build-config
 * change in aid of a test. `confirmByWebhook` in `checkout.spec.ts` computes a
 * provider signature locally for exactly the same reason.
 *
 * It verifies nothing. If this and the API ever disagree, the test fails — it
 * cannot make a wrong code look right.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The setup key, as the page displays it, back into bytes. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** RFC 4226 HOTP, truncated to six digits. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The code an authenticator would be showing right now.
 *
 * The API accepts the step either side of its own clock, so a code generated
 * here is still valid if the request lands a few seconds later.
 */
export function totpNow(base32Secret: string, atMillis = Date.now()): string {
  return hotp(base32Decode(base32Secret), Math.floor(atMillis / 1000 / 30));
}
