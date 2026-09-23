import { expect, test } from '@playwright/test';
import { registerCustomer } from './fixtures';

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
  await expect(page.getByRole('heading', { name: 'Draws', level: 1 })).toBeVisible();

  const open = page.getByTestId('open-draws');
  await expect(open.getByTestId('draw-card')).toHaveCount(2);
  await expect(open).toContainText('Highland lodge escape');
  await expect(open).toContainText('£2.99');
  await expect(page.getByTestId('upcoming-draws')).toContainText('Vintage whisky collection');

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

  await page.getByRole('link', { name: 'Sign in to reserve' }).click();
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
  await page.getByRole('button', { name: 'Reserve tickets' }).click();

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
  await expect(page.getByTestId('no-draws')).toBeVisible();
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
