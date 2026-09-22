import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

/** The staff account created by global.setup.ts (support role: admin shell, no gate changes). */
export const STAFF_EMAIL_FILE = 'test-results/.e2e-staff-email';

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomInt(1e9).toString(36)}@example.com`;
}

export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
