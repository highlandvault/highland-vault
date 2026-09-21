import { expect, test } from '@playwright/test';

test('home page renders the development shell and API status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Development shell' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toContainText('API');
});

for (const [path, name] of [
  ['/uk', 'United Kingdom'],
  ['/ie', 'Ireland'],
] as const) {
  test(`${path} renders the ${name} market shell`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('market-heading')).toHaveText(name);
  });
}

test('/de returns 404 while Germany is gated', async ({ page }) => {
  const response = await page.goto('/de');
  expect(response?.status()).toBe(404);
});

test('unknown markets return 404', async ({ page }) => {
  const response = await page.goto('/xx');
  expect(response?.status()).toBe(404);
});
