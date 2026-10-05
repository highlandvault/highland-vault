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
 *
 * **The homepage assertions were rewritten for the reference design.** The
 * page itself changed — a hero built around the featured draw, category cards,
 * a showcase and a trust strip, in place of the hero/steps/principles band
 * that came before — so the assertions describe what is there now. Everything
 * about the chrome, the market gate and the downstream routes is unchanged,
 * and so are the tests for it.
 */

test('the homepage leads with the product', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  // The heading names a real prize, read from the payload rather than typed
  // into the page. This is the assertion that keeps the design's placeholder
  // copy out of the one place it would do real harm.
  const title = page.getByTestId('hero-title');
  await expect(title).toBeVisible();
  // The article is lowercased, so the sentence reads 'Win a week in a Highland
  // lodge' rather than 'Win A week', and the tail is set apart.
  await expect(title).toContainText('Win a');
  await expect(title).toContainText('week in a Highland lodge');
  // The seeded draw the design's own copy names, which must never appear: the
  // page shows the API's prize, not the mock-up's.
  await expect(title).not.toContainText('Macallan');

  // The hero's own card is the featured draw, with its live entry meter.
  await expect(page.getByTestId('hero-card')).toBeVisible();
  await expect(page.getByTestId('hero-entries')).toBeVisible();

  // The sections the design is built from.
  await expect(page.getByTestId('categories')).toBeVisible();
  await expect(page.getByTestId('trust-strip')).toBeVisible();
  // The call to action on the featured draw, which is the page's whole point.
  await expect(page.getByRole('link', { name: 'Enter now' }).first()).toBeVisible();
});

test('the homepage shows real draws from the API, and only permitted ones', async ({ page }) => {
  await page.goto('/');

  const draws = page.getByTestId('home-draws');
  await expect(draws.getByTestId('row-card').first()).toBeVisible();
  // Seeded, live, and in an open market.
  await expect(page.getByTestId('featured-draw')).toContainText('Highland lodge escape');

  // The gate reaches the front page. Each of these exists in the database and
  // none of them may appear: the German draw is live but its market is not
  // approved, and the other two are a draft and a cancelled draw.
  const main = page.locator('main#main');
  await expect(main).not.toContainText('German draw');
  await expect(main).not.toContainText('Secret draft');
  await expect(main).not.toContainText('Withdrawn draw');
});

test('the homepage does not publish the API health readout', async ({ page }) => {
  await page.goto('/');
  // It was on the public homepage and told anyone who looked whether the
  // database and Redis were up. The component still exists for internal use.
  await expect(page.getByTestId('api-status')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('redis');
});

/**
 * The homepage carries claims this repository cannot substantiate — a review
 * score, a winner count, a Trustpilot rating, a registered address — all of
 * them from the design and all of them flagged in `home-content.ts`. The one
 * thing standing between them and a search index is this tag, so it is
 * asserted rather than trusted.
 */
test('the site is not indexable while the design carries placeholder claims', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('the footer carries real navigation only', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');

  await expect(footer.getByRole('link', { name: /United Kingdom/ })).toHaveAttribute(
    'href',
    '/uk/draws',
  );
  await expect(footer.getByRole('link', { name: /Ireland/ })).toHaveAttribute('href', '/ie/draws');
  await expect(footer).toContainText(String(new Date().getFullYear()));

  // No closed market, and nothing internal.
  await expect(footer.locator('a[href^="/de"]')).toHaveCount(0);
  await expect(footer.locator('a[href^="/admin"]')).toHaveCount(0);
});

/**
 * The header is the only route to an account now: the design replaced the
 * explicit "Sign in" and "Register" links with one account action, and
 * `/account` sends a signed-out visitor to the sign-in page. Registration is
 * still one link from there, which is what this asserts — the journey has to
 * survive the chrome being redrawn.
 */
test('an account is still reachable from the chrome', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'My Account' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
  await expect(page.getByRole('link', { name: 'Register' })).toHaveAttribute('href', '/register');
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
