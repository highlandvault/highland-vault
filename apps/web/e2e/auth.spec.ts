import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PASSWORD, STAFF_EMAIL_FILE, signIn, uniqueEmail } from './fixtures';

test('register, sign out and sign in again', async ({ page }) => {
  const email = uniqueEmail('e2e');
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId('account-email')).toHaveText(email);

  // The session cookie is HttpOnly: page scripts cannot read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain('hv_session');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);

  await signIn(page, email);
  await expect(page.getByTestId('account-email')).toHaveText(email);
});

test('a wrong password shows an error and no session', async ({ page }) => {
  await signIn(page, uniqueEmail('nobody'));
  await expect(page.getByTestId('form-error')).toHaveText('The email or password is incorrect.');
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login/);
});

test.describe('admin shell', () => {
  test('sends signed-out visitors to sign-in', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
  });

  test('is a 404 for customers', async ({ page }) => {
    const email = uniqueEmail('customer');
    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel(/Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/account$/);

    const response = await page.goto('/admin');
    expect(response?.status()).toBe(404);
  });

  test('shows staff the market gate state, with Germany gated', async ({ page }) => {
    const staffEmail = readFileSync(STAFF_EMAIL_FILE, 'utf8').trim();
    await signIn(page, staffEmail, '/admin');
    await expect(page.getByTestId('admin-shell')).toContainText(`signed in as ${staffEmail}`);
    await expect(page.getByTestId('gate-uk')).toContainText('United Kingdom (uk)GBPyesyesyes');
    await expect(page.getByTestId('gate-de')).toContainText('required, not recorded');
    await expect(page.getByTestId('gate-de')).toContainText('min_age, self_exclusion_required');
  });
});
