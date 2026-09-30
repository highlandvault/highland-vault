import { expect, test } from '@playwright/test';

/**
 * The public homepage, the shared chrome, and the market gate.
 *
 * The e2e database enables UK and IE with test fixture values; DE is left as
 * the migrations create it (disabled, no legal approval) although the e2e API
 * lists it in ENABLED_MARKETS. The web app has no market list of its own.
 *
 * The homepage has been through two rewrites. It was a developer index — a
 * market chooser and a live readout of the API's health. It became a product
 * page. It is now the visual redesign, and these tests follow it: the sections
 * are new, but what they protect has not changed. The draws on the page are
 * the API's real draws, the market gate reaches all the way to the front page,
 * and infrastructure status is not published to the public.
 */

test('the homepage leads with the featured draw', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  // The heading names a real prize, from the API rather than the page.
  const title = page.getByTestId('hero-title');
  await expect(title).toBeVisible();
  await expect(title).toContainText('A week in a Highland lodge');

  // Badges are only rendered for facts the payload supports: the market, the
  // status, and more than one winner position.
  const badges = page.getByTestId('hero-badges');
  await expect(badges).toContainText('United Kingdom');
  await expect(badges).toContainText('Open');
  await expect(badges).toContainText('2 winner positions');

  // Four statements about how the product works, and not one of them a
  // statistic, a rating or a claim about the world.
  const values = page.getByTestId('hero-values');
  await expect(values.getByRole('listitem')).toHaveCount(4);
  await expect(values).toContainText('Skill question');
  await expect(values).toContainText('Secure checkout');

  // Nothing invented: no review scores, no winner counts, no ratings.
  const body = page.locator('body');
  await expect(body).not.toContainText('Trustpilot');
  await expect(body).not.toContainText('10,000+');
  await expect(body).not.toContainText('reviews');
});

test('the hero card shows the draw closing, entries and price from the API', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('hero-card');
  await expect(card).toBeVisible();

  // The countdown hydrates and shows real units.
  await expect(card.getByTestId('draw-countdown')).toContainText('days');
  await expect(card.getByTestId('draw-countdown')).toContainText('hrs');

  // Entries come from the availability endpoint: 4,000 is the seeded total.
  await expect(card.getByTestId('hero-entries')).toContainText('4,000');
  await expect(card.getByTestId('hero-entries')).toContainText('entries');
  await expect(card.getByRole('progressbar')).toBeVisible();

  // The seeded entry price, formatted for the market.
  await expect(card).toContainText('£2.99');
  await expect(card.getByRole('link', { name: /Enter now/ })).toHaveAttribute(
    'href',
    '/uk/draws/highland-lodge-escape',
  );
});

test('the market row offers every open market and no closed one', async ({ page }) => {
  await page.goto('/');
  const markets = page.getByTestId('markets');
  await expect(markets.getByRole('link', { name: /United Kingdom/ })).toHaveAttribute(
    'href',
    '/uk/draws',
  );
  await expect(markets.getByRole('link', { name: /Ireland/ })).toHaveAttribute('href', '/ie/draws');
  // The gate reaches the front page: Germany is disabled in the database.
  await expect(markets.locator('a[href^="/de"]')).toHaveCount(0);
});

test('the competitions section shows real draws, and only permitted ones', async ({ page }) => {
  await page.goto('/');

  const featured = page.getByTestId('featured-draw');
  await expect(featured).toContainText('Highland lodge escape');
  await expect(featured.getByRole('link', { name: /Enter now/ })).toHaveAttribute(
    'href',
    '/uk/draws/highland-lodge-escape',
  );

  const rows = page.getByTestId('home-draws');
  await expect(rows.getByTestId('row-card').first()).toBeVisible();
  await expect(rows).toContainText('Last tickets');

  // Each of these exists in the database and none may appear: the German draw
  // is live but its market is not approved, and the other two are a draft and
  // a cancelled draw.
  const body = page.locator('body');
  await expect(body).not.toContainText('German draw');
  await expect(body).not.toContainText('Secret draft');
  await expect(body).not.toContainText('Withdrawn draw');
});

test('the editorial banner, how it works and the trust strip are present', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Discover the vault' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore competitions/ })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
  for (const step of [
    'Choose a market',
    'Select a draw',
    'Answer and enter',
    'Follow your order',
  ]) {
    await expect(page.getByRole('heading', { name: new RegExp(step) })).toBeVisible();
  }

  const trust = page.getByTestId('trust-strip');
  await expect(trust.getByRole('listitem')).toHaveCount(4);
  await expect(trust).toContainText('Secure checkout');
  // No numeric claim anywhere in the strip.
  await expect(trust).not.toContainText('/5');
});

test('the header carries only navigation that leads somewhere', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const header = page.getByRole('banner');

  // Exact, because the search icon's accessible name is 'Search competitions'.
  await expect(header.getByRole('link', { name: 'Competitions', exact: true })).toHaveAttribute(
    'href',
    '/#competitions',
  );
  await expect(header.getByRole('link', { name: 'How it works', exact: true })).toHaveAttribute(
    'href',
    '/#how-it-works',
  );
  await expect(header.getByRole('link', { name: /Enter now/ })).toBeVisible();
  // Distinct from the listing's own search field, which is labelled
  // 'Search competitions'.
  await expect(header.getByRole('link', { name: 'Search', exact: true })).toBeVisible();

  // Winners, About and Contact have no pages yet, so they are text rather than
  // links. Rendering them as links would be three items that 404.
  for (const label of ['Winners', 'About', 'Contact']) {
    await expect(header).toContainText(label);
    await expect(header.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
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
  await expect(footer).toContainText(String(new Date().getFullYear()));

  // No closed market, nothing internal, and no invented postal address or
  // social account — none is configured in this repository.
  await expect(footer.locator('a[href^="/de"]')).toHaveCount(0);
  await expect(footer.locator('a[href^="/admin"]')).toHaveCount(0);
  await expect(footer.locator('a[href^="http"]')).toHaveCount(0);
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

test('the homepage does not overflow sideways at any supported width', async ({ page }) => {
  for (const width of [320, 360, 375, 390, 414, 768, 900, 1080, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0);
  }
});

test('on a phone the hero stacks and the sections keep their order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');

  const title = await page.getByTestId('hero-title').boundingBox();
  const card = await page.getByTestId('hero-card').boundingBox();
  const markets = await page.getByTestId('markets').boundingBox();
  const featured = await page.getByTestId('featured-draw').boundingBox();

  // Content first, then the artwork and its card, then the rest of the page.
  expect(title!.y).toBeLessThan(card!.y);
  expect(card!.y).toBeLessThan(markets!.y);
  expect(markets!.y).toBeLessThan(featured!.y);

  // No floating call to action was introduced.
  await expect(page.locator('.entry-bar')).toHaveCount(0);
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
