import { expect, test } from '@playwright/test';

// The e2e database enables UK and IE with test fixture values; DE is left as
// the migrations create it (disabled, no legal approval) although the e2e API
// lists it in ENABLED_MARKETS. The web app has no market list of its own.

test('home page renders the market chooser, API status and the available markets', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose your market' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toContainText('API ok');
  const markets = page.getByTestId('market-list');
  await expect(markets).toContainText('/uk — United Kingdom (GBP)');
  await expect(markets).toContainText('/ie — Ireland (EUR)');
  await expect(markets).not.toContainText('/de');
});

for (const [path, name, detail] of [
  ['/uk', 'United Kingdom', 'prices in GBP'],
  ['/ie', 'Ireland', 'prices in EUR'],
] as const) {
  test(`${path} renders the ${name} market home from the API`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('market-heading')).toHaveText(name);
    await expect(page.getByText(detail)).toBeVisible();
  });
}

test('/de returns 404 while Germany is gated', async ({ page }) => {
  const response = await page.goto('/de');
  expect(response?.status()).toBe(404);
});

test('unknown markets return 404', async ({ page }) => {
  for (const path of ['/xx', '/fr', '/UK']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
});
