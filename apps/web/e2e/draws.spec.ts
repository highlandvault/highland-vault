import { expect, test, type Locator } from '@playwright/test';
import { registerCustomer } from './fixtures';

/**
 * The three seeded UK draws, in no particular order.
 *
 * `admin-draws.spec.ts` publishes a draw of its own into this same market —
 * "E2E test draw", £1.50, opening tomorrow — and it may or may not exist
 * depending on which spec ran first. So the ordering assertions below read the
 * positions of these three relative to each other and ignore anything else,
 * rather than trusting an absolute index that another spec can move.
 */
const FIXTURES = ['Highland lodge escape', 'Last tickets', 'Vintage whisky collection'] as const;

async function fixtureOrder(list: Locator): Promise<string[]> {
  const cards = await list.getByTestId('draw-card').allTextContents();
  return cards
    .map((text) => FIXTURES.find((title) => text.includes(title)))
    .filter((title): title is (typeof FIXTURES)[number] => title !== undefined);
}

// Seeded by `pnpm --filter @hv/db e2e:prepare` (test fixtures, not real draws):
//   uk: highland-lodge-escape (open, 4,000 tickets), last-tickets (open, 4 tickets),
//       vintage-whisky-collection (upcoming), secret-draft (draft), withdrawn-draw (cancelled)
//   ie: no draws
//   de: de-draw (published, but Germany is disabled)
// Runs on desktop and on a phone viewport (the `mobile` project).

test('customer opens a market, browses draws, opens one and sees its skill question', async ({
  page,
}) => {
  await page.goto('/uk');
  await expect(page.getByTestId('market-heading')).toHaveText('United Kingdom');

  await page.getByRole('link', { name: 'Browse draws' }).click();
  await expect(page).toHaveURL(/\/uk\/draws$/);
  await expect(
    page.getByRole('heading', { name: 'Competitions worth entering.', level: 1 }),
  ).toBeVisible();
  // The market's own name and currency, from the API rather than the URL.
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
    'United Kingdom',
  );

  const open = page.getByTestId('open-draws');
  await expect(open.getByTestId('draw-card')).toHaveCount(2);
  await expect(open).toContainText('Highland lodge escape');
  await expect(open).toContainText('£2.99');
  await expect(page.getByTestId('upcoming-draws')).toContainText('Vintage whisky collection');
  // Counted from what is actually on the page. Only the open count is ours to
  // predict — another spec publishes an upcoming draw into this market.
  await expect(page.getByTestId('result-summary')).toContainText('2 open');
  await expect(page.getByTestId('result-summary')).toContainText('competitions');

  await open.getByRole('link', { name: 'Highland lodge escape' }).click();
  await expect(page).toHaveURL(/\/uk\/draws\/highland-lodge-escape$/);
  await expect(page.getByTestId('draw-title')).toHaveText('Highland lodge escape');
  await expect(page.getByTestId('draw-status').first()).toHaveText('Open');
  await expect(page.getByTestId('prize-list')).toContainText('A week in a Highland lodge');
  await expect(page.getByTestId('prize-list')).toContainText('Weekend spa break');
  await expect(page.getByTestId('draw-closes')).toBeVisible();

  const question = page.getByTestId('skill-question');
  await expect(question).toContainText('what is 2 + 3?');
  await expect(question.getByRole('listitem')).toHaveCount(3);
});

test('signed out, the entry panel shows real availability and exact totals', async ({ page }) => {
  await page.goto('/uk/draws/highland-lodge-escape');
  // Other tests reserve from this draw in parallel, so only the total is fixed.
  await expect(page.getByTestId('availability')).toContainText(/of 4,000 tickets available/);
  await expect(page.getByTestId('entry-total')).toHaveText('£2.99');
  await page.getByRole('button', { name: 'One more entry' }).click();
  await page.getByRole('button', { name: 'One more entry' }).click();
  await expect(page.getByTestId('entry-quantity')).toHaveText('3');
  await expect(page.getByTestId('entry-total')).toHaveText('£8.97');

  await page.getByRole('link', { name: 'Sign in to buy' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fuk%2Fdraws%2Fhighland-lodge-escape$/);
});

test('a customer reserves tickets and sees their numbers, total and a countdown that survives a reload', async ({
  page,
}) => {
  await registerCustomer(page, 'reserve');
  await page.goto('/uk/draws/highland-lodge-escape');
  await page.getByRole('button', { name: 'One more entry' }).click();
  await page.getByRole('button', { name: 'One more entry' }).click();
  await expect(page.getByTestId('entry-total')).toHaveText('£8.97');
  await page.getByRole('button', { name: 'Add to basket' }).click();

  // P6-8: the purchase journey is basket-first, because an order is built from
  // the basket (ADR-0032). Adding still takes a real hold through the ticket
  // engine — the same allocation, under the same cap and the same locks — so
  // everything this test proved about the tickets is still proved, one page on.
  await expect(page).toHaveURL(/\/uk\/basket$/);
  await expect(page.getByTestId('basket-line-total')).toHaveText('£8.97');
  await expect(page.getByTestId('basket-total')).toHaveText('£8.97');

  await page.getByTestId('basket-line-tickets').click();
  await expect(page).toHaveURL(/\/uk\/reservations\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('reservation-title')).toHaveText('Your tickets are reserved');
  const numbers = page.getByTestId('ticket-number');
  await expect(numbers).toHaveCount(3);
  // Sequential numbers, padded to the size of the draw (4,000 tickets → four digits).
  for (const text of await numbers.allTextContents()) expect(text).toMatch(/^#\d{4}$/);
  const held = await numbers.allTextContents();
  await expect(page.getByTestId('reservation-total')).toHaveText('£8.97');
  await expect(page.getByTestId('countdown')).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(page.getByTestId('checkout-unavailable')).toBeVisible();

  // The countdown follows the server: a reload shows the same reservation, still running.
  const before = await page.getByTestId('countdown').textContent();
  await page.reload();
  await expect(page.getByTestId('ticket-number')).toHaveText(held);
  await expect(page.getByTestId('countdown')).toHaveText(/^\d{1,2}:\d{2}$/);
  const after = await page.getByTestId('countdown').textContent();
  const seconds = (t: string | null) => {
    const [m, s] = (t ?? '0:00').split(':').map(Number);
    return m! * 60 + s!;
  };
  expect(seconds(after)).toBeLessThanOrEqual(seconds(before));

  // The numbers are held: the draw's allowance for this customer went down.
  await page.goto('/uk/draws/highland-lodge-escape');
  await expect(page.getByText('47 left for you')).toBeVisible();

  await page.goBack();
  await page.getByRole('button', { name: 'Release these tickets' }).click();
  await expect(page.getByTestId('reservation-title')).toHaveText('You released this reservation');
  await expect(page.getByTestId('ticket-number')).toHaveCount(0);
});

test('an upcoming draw shows when it opens and does not offer entry', async ({ page }) => {
  await page.goto('/uk/draws/vintage-whisky-collection');
  await expect(page.getByTestId('draw-status').first()).toHaveText('Opening soon');
  await expect(page.getByRole('button', { name: 'Entries not open' })).toBeDisabled();
});

test('a market without draws shows the empty state', async ({ page }) => {
  const response = await page.goto('/ie/draws');
  expect(response?.status()).toBe(200);
  const empty = page.getByTestId('no-draws');
  await expect(empty).toBeVisible();
  // Named from the market data, not from the URL segment.
  await expect(empty).toContainText('Ireland');
  // Nothing to filter, so the "no matches" state must not appear instead.
  await expect(page.getByTestId('no-matches')).toHaveCount(0);
});

for (const path of [
  '/uk/draws/secret-draft', // unpublished
  '/uk/draws/withdrawn-draw', // cancelled
  '/ie/draws/highland-lodge-escape', // another market's draw
  '/uk/draws/no-such-draw',
]) {
  test(`${path} is not found`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  });
}

/**
 * The catalogue controls (UI-2).
 *
 * Every one of these is a URL. The toolbar is a plain `<form method="get">`,
 * so the filtered view is reachable by typing the address, by the back button
 * and with JavaScript disabled — and the assertions below go through the
 * address bar to prove exactly that.
 *
 * The listing API takes no query string of its own; all of this is applied in
 * the web layer to the one answer it gives.
 */
test('status filtering narrows the listing to one group', async ({ page }) => {
  await page.goto('/uk/draws?status=open');
  const results = page.getByTestId('draw-results');
  await expect(results.getByTestId('draw-card')).toHaveCount(2);
  await expect(results).toContainText('Highland lodge escape');
  await expect(results).toContainText('Last tickets');
  await expect(results).not.toContainText('Vintage whisky collection');
  await expect(page.getByTestId('result-summary')).toContainText('2 open');
  await expect(page.getByTestId('result-summary')).not.toContainText('opening soon');
  // Grouping collapses: a single status has nothing to group by.
  await expect(page.getByTestId('open-draws')).toHaveCount(0);

  await page.goto('/uk/draws?status=upcoming');
  const upcoming = page.getByTestId('draw-results');
  await expect(upcoming).toContainText('Vintage whisky collection');
  await expect(upcoming).not.toContainText('Highland lodge escape');
  await expect(upcoming).not.toContainText('Last tickets');
  await expect(page.getByTestId('result-summary')).toContainText('opening soon');
});

test('sorting by price orders every result, not each group', async ({ page }) => {
  await page.goto('/uk/draws?sort=price-asc');
  // Vintage whisky £2.50, Highland lodge £2.99, Last tickets £5.00.
  expect(await fixtureOrder(page.getByTestId('draw-results'))).toEqual([
    'Vintage whisky collection',
    'Highland lodge escape',
    'Last tickets',
  ]);

  await page.goto('/uk/draws?sort=price-desc');
  expect(await fixtureOrder(page.getByTestId('draw-results'))).toEqual([
    'Last tickets',
    'Highland lodge escape',
    'Vintage whisky collection',
  ]);
});

test('sorting by closing time puts the open draws first', async ({ page }) => {
  await page.goto('/uk/draws?sort=closing-soon');
  // Both open draws close in 7 days and the upcoming one in 9, so the only
  // relation the fixtures fix is that the whisky comes last of the three.
  const order = await fixtureOrder(page.getByTestId('draw-results'));
  expect(order).toHaveLength(3);
  expect(order[2]).toBe('Vintage whisky collection');
});

test('searching the title finds a partial, case-insensitive match', async ({ page }) => {
  await page.goto('/uk/draws?q=lodge');
  await expect(page.getByTestId('draw-card')).toHaveCount(1);
  await expect(page.getByTestId('open-draws')).toContainText('Highland lodge escape');
  await expect(page.getByTestId('result-summary')).toHaveText('1 competition · 1 open');
  await expect(page.getByTestId('clear-filters')).toBeVisible();

  // Case is not a filter.
  await page.goto('/uk/draws?q=LODGE');
  await expect(page.getByTestId('draw-card')).toHaveCount(1);

  // Whitespace is not a search term.
  await page.goto('/uk/draws?q=%20%20whisky%20%20');
  await expect(page.getByTestId('draw-card')).toHaveCount(1);
  await expect(page.getByTestId('upcoming-draws')).toContainText('Vintage whisky collection');
});

test('a search with no matches says so, and offers a way back', async ({ page }) => {
  await page.goto('/uk/draws?q=nothing-matches-this');
  // Distinct from "this market has no competitions", which would be untrue.
  await expect(page.getByTestId('no-matches')).toBeVisible();
  await expect(page.getByTestId('no-draws')).toHaveCount(0);
  await expect(page.getByTestId('draw-card')).toHaveCount(0);
  await expect(page.getByTestId('result-summary')).toHaveText('0 competitions');

  await page.getByTestId('no-matches').getByRole('link', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/uk\/draws$/);
  await expect(page.getByTestId('open-draws').getByTestId('draw-card')).toHaveCount(2);
});

test('clear filters returns to the default grouped view', async ({ page }) => {
  await page.goto('/uk/draws?status=open&sort=price-desc&q=tickets');
  await expect(page.getByTestId('draw-results')).toContainText('Last tickets');

  await page.getByTestId('clear-filters').click();
  await expect(page).toHaveURL(/\/uk\/draws$/);
  await expect(page.getByTestId('open-draws')).toBeVisible();
  await expect(page.getByTestId('upcoming-draws')).toBeVisible();
  // Gone, because there is nothing left to clear.
  await expect(page.getByTestId('clear-filters')).toHaveCount(0);
});

test('the toolbar submits without JavaScript and produces a shareable URL', async ({ browser }) => {
  // The whole reason it is a GET form rather than client state — and the
  // reason this segment has no `loading.tsx`. A Suspense boundary here streams
  // the results in after the shell, and without scripting they never arrive:
  // the page rendered the word "Loading" and stopped. See the page's docstring.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/uk/draws');
    await page.getByLabel('Search competitions').fill('whisky');
    await page.getByLabel('Show').selectOption('upcoming');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page).toHaveURL(/q=whisky/);
    await expect(page).toHaveURL(/status=upcoming/);
    await expect(page.getByTestId('draw-results')).toContainText('Vintage whisky collection');
    await expect(page.getByTestId('draw-card')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('nonsense query parameters fall back to the default view', async ({ page }) => {
  // A URL gets typed, truncated and edited by hand. None of this is worth an
  // error page, and none of it may change what a customer is allowed to see.
  for (const query of [
    '?sort=nonsense',
    '?status=deleted',
    '?sort=&status=',
    '?sort[]=price-asc',
    '?status=open&status=all',
    '?q=' + 'x'.repeat(500),
  ]) {
    const response = await page.goto('/uk/draws' + query);
    expect(response?.status(), query).toBe(200);
    // Either the default grouped view, or an honest "no matches" - never a crash.
    const crashed = await page.getByText('Application error').count();
    expect(crashed, query).toBe(0);
  }

  // And the plainly invalid ones land on the default view itself.
  await page.goto('/uk/draws?sort=nonsense&status=deleted');
  await expect(page.getByTestId('open-draws').getByTestId('draw-card')).toHaveCount(2);
  await expect(page.getByTestId('upcoming-draws')).toBeVisible();
  await expect(page.getByTestId('clear-filters')).toHaveCount(0);
});

test('a filter can never surface a draw the API does not list', async ({ page }) => {
  // The gate is the API's, and no arrangement of the query string moves it.
  for (const query of ['?q=secret', '?q=withdrawn', '?q=draft', '?status=all&sort=price-asc']) {
    await page.goto('/uk/draws' + query);
    await expect(page.getByText('Secret draft')).toHaveCount(0);
    await expect(page.getByText('Withdrawn draw')).toHaveCount(0);
  }
});

test('unpublished draws never appear in the listing', async ({ page }) => {
  await page.goto('/uk/draws');
  await expect(page.getByText('Secret draft')).toHaveCount(0);
  await expect(page.getByText('Withdrawn draw')).toHaveCount(0);
});

test('Germany stays blocked everywhere, although a German draw is published', async ({ page }) => {
  for (const path of ['/de', '/de/draws', '/de/draws/de-draw']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
});
