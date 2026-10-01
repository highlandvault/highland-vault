import { expect, test } from '@playwright/test';

/**
 * The public homepage, the shared chrome, and the market gate.
 *
 * The e2e database enables UK and IE with test fixture values; DE is left as
 * the migrations create it (disabled, no legal approval) although the e2e API
 * lists it in ENABLED_MARKETS. The web app has no market list of its own.
 *
 * The homepage used to be a developer index — a market chooser and a live
 * readout of the API's health — and these tests asserted that. It is a product
 * page now, so they assert the product: that the draws on it are the API's
 * real draws, that the market gate reaches all the way to the front page, and
 * that infrastructure status is no longer published to the public.
 */

test('the homepage leads with the product', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Exceptional prizes.');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('One fair draw.');

  // Both calls to action: the hero's and the closing section's.
  await expect(page.getByRole('link', { name: 'Explore competitions' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'How it works', exact: true })).toHaveCount(2);

  // How it works, and the principles band.
  await expect(page.getByRole('heading', { name: 'Three steps, start to finish.' })).toBeVisible();
  for (const step of ['Choose your draw', 'Answer and enter', 'Check your result']) {
    await expect(page.getByRole('heading', { name: step })).toBeVisible();
  }
  for (const principle of ['Clear entry', 'Transparent draws', 'Secure checkout']) {
    await expect(page.getByRole('heading', { name: principle })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Find your next prize.' })).toBeVisible();
});

test('the homepage shows real draws from the API, and only permitted ones', async ({ page }) => {
  await page.goto('/');

  const draws = page.getByTestId('home-draws');
  await expect(draws.getByTestId('draw-card').first()).toBeVisible();
  // Seeded, live, and in an open market.
  await expect(draws).toContainText('Highland lodge escape');

  // The gate reaches the front page. Each of these exists in the database and
  // none of them may appear: the German draw is live but its market is not
  // approved, and the other two are a draft and a cancelled draw.
  await expect(draws).not.toContainText('German draw');
  await expect(draws).not.toContainText('Secret draft');
  await expect(draws).not.toContainText('Withdrawn draw');

  // Every open market is offered, and no closed one is.
  const markets = page.getByTestId('markets');
  await expect(markets.getByRole('link', { name: /United Kingdom/ })).toHaveAttribute(
    'href',
    '/uk/draws',
  );
  await expect(markets.getByRole('link', { name: /Ireland/ })).toHaveAttribute('href', '/ie/draws');
  await expect(markets.locator('a[href^="/de"]')).toHaveCount(0);
});

test('the homepage does not publish the API health readout', async ({ page }) => {
  await page.goto('/');
  // It was on the public homepage and told anyone who looked whether the
  // database and Redis were up. The component still exists for internal use.
  await expect(page.getByTestId('api-status')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('redis');
});

test('the footer carries real navigation only', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');

  await expect(footer.getByRole('link', { name: /United Kingdom/ })).toHaveAttribute(
    'href',
    '/uk/draws',
  );
  await expect(footer.getByRole('link', { name: /Ireland/ })).toHaveAttribute('href', '/ie/draws');
  await expect(footer.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  await expect(footer.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
    'href',
    '/register',
  );
  await expect(footer).toContainText(String(new Date().getFullYear()));

  // No closed market, and nothing internal.
  await expect(footer.locator('a[href^="/de"]')).toHaveCount(0);
  await expect(footer.locator('a[href^="/admin"]')).toHaveCount(0);
});

test('the skip link still reaches the main landmark', async ({ page }) => {
  await page.goto('/');
  // The homepage owns its own <main>, so the shared skip link has to still
  // find it. Keyboard-first users lose the page entirely if it does not.
  await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
    'href',
    '#main',
  );
  await expect(page.locator('main#main')).toHaveCount(1);
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
