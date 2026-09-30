import { expect, test } from '@playwright/test';

/**
 * The public homepage, the shared chrome, and the market gate.
 *
 * The e2e database enables UK and IE with test fixture values; DE is left as
 * the migrations create it (disabled, no legal approval) although the e2e API
 * lists it in ENABLED_MARKETS. The web app has no market list of its own.
 *
 * The homepage is built to the supplied reference design, which asks for
 * content this product does not have: categories, instant-win prizes, brand
 * promises and review scores. All of it lives in `src/app/home-content.ts`,
 * labelled, and these tests assert it renders — **and separately assert that
 * none of it reaches the parts of the page that come from the API.** The draws
 * are the API's draws, the market gate still reaches the front page, and
 * infrastructure status is still not published.
 */

test('the homepage leads with the featured draw from the API', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  // The heading names a real prize, read from the payload rather than typed
  // into the page. This is the assertion that keeps the design's placeholder
  // copy out of the one place it would do real harm.
  const title = page.getByTestId('hero-title');
  await expect(title).toBeVisible();
  await expect(title).toContainText('A week in a Highland lodge');
  await expect(title).not.toContainText('Macallan');
});

test('the hero card shows closing, entries and price from the API', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('hero-card');
  await expect(card).toBeVisible();

  await expect(card.getByTestId('draw-countdown')).toContainText('days');
  await expect(card.getByTestId('draw-countdown')).toContainText('hrs');

  // 4,000 is the seeded total for this draw, from the availability endpoint.
  await expect(card.getByTestId('hero-entries')).toContainText('4,000');
  await expect(card.getByRole('progressbar')).toBeVisible();

  // The seeded entry price, formatted for the market — not the design's £4.99.
  await expect(card).toContainText('£2.99');
  await expect(card).not.toContainText('£4.99');
  await expect(card.getByRole('link', { name: /Enter now/ })).toHaveAttribute(
    'href',
    '/uk/draws/highland-lodge-escape',
  );
});

test('the five categories render, and the ones without draws lead nowhere', async ({ page }) => {
  await page.goto('/');
  const cats = page.getByTestId('categories');
  await expect(cats.getByRole('listitem')).toHaveCount(5);
  for (const name of ['Whisky', 'Tech', 'Cars', 'Property', 'Experiences']) {
    await expect(cats).toContainText(name);
  }
  // There is no category endpoint, so none of them is a link yet. A card that
  // navigated somewhere invented would be worse than one that waits.
  await expect(cats.locator('a')).toHaveCount(0);
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

  // The gate reaches the front page. Each of these exists in the database and
  // none may appear: the German draw is live but its market is not approved,
  // and the other two are a draft and a cancelled draw.
  const body = page.locator('body');
  await expect(body).not.toContainText('German draw');
  await expect(body).not.toContainText('Secret draft');
  await expect(body).not.toContainText('Withdrawn draw');
});

test('the instant-prize panel renders its placeholder prizes', async ({ page }) => {
  await page.goto('/');
  // Instant wins are Phase 8: no table, no contract, no API field. The panel
  // is part of the design, and everything in it comes from `home-content.ts`.
  const panel = page.getByTestId('instant');
  await expect(panel).toContainText('Instant prizes in this draw');
  await expect(panel.locator('.ip')).toHaveCount(5);
  await expect(panel).toContainText('£50 Cash');
});

test('the banner, how it works and the trust strip are present', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Discover rare whiskies' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore whisky draws/ })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
  for (const step of ['Choose a Category', 'Select a Draw', 'Enter & Win', 'See the Results']) {
    await expect(page.getByRole('heading', { name: new RegExp(step) })).toBeVisible();
  }

  await expect(page.getByTestId('trust-strip').getByRole('listitem')).toHaveCount(4);
});

test('the header carries the design nav, linking only where a page exists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const header = page.getByRole('banner');

  await expect(header.getByRole('link', { name: 'Competitions', exact: true })).toHaveAttribute(
    'href',
    '/#competitions',
  );
  await expect(header.getByRole('link', { name: 'How It Works', exact: true })).toHaveAttribute(
    'href',
    '/#how-it-works',
  );
  await expect(header.getByRole('link', { name: /Enter now/ })).toBeVisible();
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

test('the footer carries the design footer, and no invented link', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');

  await expect(footer.getByRole('link', { name: /United Kingdom/ })).toHaveAttribute(
    'href',
    '/uk/draws',
  );
  await expect(footer.getByRole('link', { name: /Ireland/ })).toHaveAttribute('href', '/ie/draws');
  await expect(footer).toContainText(String(new Date().getFullYear()));
  await expect(footer).toContainText('Mohali');

  // The social marks render, but none links out: no account is configured, and
  // linking to one that may not be ours is worse than an unlinked icon.
  await expect(footer.locator('.social')).toHaveCount(4);
  await expect(footer.locator('a[href^="http"]')).toHaveCount(0);

  // No closed market, nothing internal.
  await expect(footer.locator('a[href^="/de"]')).toHaveCount(0);
  await expect(footer.locator('a[href^="/admin"]')).toHaveCount(0);
});

test('the skip link still reaches the main landmark', async ({ page }) => {
  await page.goto('/');
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

test('on a phone the sections keep their order and nothing floats', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');

  const title = await page.getByTestId('hero-title').boundingBox();
  const card = await page.getByTestId('hero-card').boundingBox();
  const cats = await page.getByTestId('categories').boundingBox();
  const featured = await page.getByTestId('featured-draw').boundingBox();

  expect(title!.y).toBeLessThan(card!.y);
  expect(card!.y).toBeLessThan(cats!.y);
  expect(cats!.y).toBeLessThan(featured!.y);

  // No sticky bottom call to action was introduced.
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
