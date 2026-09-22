import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL_FILE, STAFF_EMAIL_FILE, signIn } from './fixtures';

/** A datetime-local value `days` from now (the market's zone does not matter for this test). */
function localInput(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('an admin creates, completes and publishes a draw; customers then see it', async ({
  page,
}) => {
  const email = readFileSync(ADMIN_EMAIL_FILE, 'utf8').trim();
  const slug = `e2e-draw-${Date.now().toString(36)}`;
  await signIn(page, email, '/admin/draws?market=uk');

  await page.getByRole('link', { name: 'New draw' }).click();
  await page.getByLabel('Title').fill('E2E test draw');
  await page.getByLabel('URL slug').fill(slug);
  await page.getByLabel('Description').fill('Created by the Playwright suite (test data).');
  await page.getByLabel(/Entry price/).fill('1.50');
  await page.getByLabel('Total tickets').fill('100');
  await page.getByLabel('Maximum per person').fill('10');
  await page.getByLabel('Winner positions').fill('1');
  // Opens in the future, so the seeded 'open draws' seen by parallel customer tests are unchanged.
  await page.getByLabel(/^Opens/).fill(localInput(1));
  await page.getByLabel(/^Closes/).fill(localInput(5));
  await page.getByRole('button', { name: 'Create draft' }).click();

  await expect(page.getByTestId('admin-draw-status')).toHaveText('stored status: draft');
  await expect(page.getByTestId('publish-blockers')).toContainText('Add a skill question.');

  // Unpublished: customers cannot reach it.
  const hidden = await page.context().newPage();
  expect((await hidden.goto(`/uk/draws/${slug}`))?.status()).toBe(404);

  await page.getByLabel('1st prize').fill('E2E prize');
  await page.getByRole('button', { name: 'Save prizes' }).click();
  // Wait for this save specifically: a notice from an earlier save must not count.
  await expect(page.getByTestId('form-saved')).toHaveText('Saved (prizes).');

  await page.getByLabel('Question', { exact: true }).fill('How many days are in a week?');
  await page.getByLabel('Option 1').fill('5');
  await page.getByLabel('Option 2').fill('7');
  await page.getByRole('radio', { name: 'Correct answer' }).nth(1).check();
  await page.getByRole('button', { name: 'Save skill question' }).click();
  await expect(page.getByTestId('form-saved')).toHaveText('Saved (question).');
  await expect(page.getByTestId('publish-blockers')).toHaveCount(0);

  await page.getByRole('button', { name: 'Publish draw' }).click();
  await expect(page.getByTestId('admin-draw-status')).toHaveText('stored status: scheduled');

  expect((await hidden.goto(`/uk/draws/${slug}`))?.status()).toBe(200);
  await expect(hidden.getByTestId('draw-title')).toHaveText('E2E test draw');
  await expect(hidden.getByTestId('draw-status').first()).toHaveText('Opening soon');
  await expect(hidden.getByTestId('skill-question')).toContainText('How many days are in a week?');
  // The correct answer is not marked for customers.
  await expect(hidden.getByTestId('skill-question')).not.toContainText('Correct');
});

test('support staff can see draws but not create them', async ({ page }) => {
  const email = readFileSync(STAFF_EMAIL_FILE, 'utf8').trim();
  await signIn(page, email, '/admin/draws?market=uk');
  await expect(page.getByTestId('admin-draws')).toContainText('Secret draft');
  await expect(page.getByRole('link', { name: 'New draw' })).toHaveCount(0);
});
