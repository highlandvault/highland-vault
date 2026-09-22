import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

/** Staff accounts created by global.setup.ts. */
export const STAFF_EMAIL_FILE = 'test-results/.e2e-staff-email'; // support role
export const ADMIN_EMAIL_FILE = 'test-results/.e2e-admin-email'; // admin role (draws.write)

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomInt(1e9).toString(36)}@example.com`;
}

export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
