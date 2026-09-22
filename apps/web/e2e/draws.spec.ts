import { expect, test } from '@playwright/test';

// Seeded by `pnpm --filter @hv/db e2e:prepare` (test fixtures, not real draws):
//   uk: highland-lodge-escape (open), vintage-whisky-collection (upcoming),
//       secret-draft (draft), withdrawn-draw (cancelled)
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
  await expect(open.getByTestId('draw-card')).toHaveCount(1);
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
  await expect(question.getByRole('radio')).toHaveCount(3);
});

test('the entry panel is honest: no availability, no checkout, exact totals', async ({ page }) => {
  await page.goto('/uk/draws/highland-lodge-escape');
  await expect(page.getByTestId('entry-unavailable')).toContainText(
    'Online entry is not available yet',
  );
  await expect(page.getByRole('button', { name: 'Enter now' })).toBeDisabled();

  await expect(page.getByTestId('entry-total')).toHaveText('£2.99');
  await page.getByRole('button', { name: 'One more entry' }).click();
  await page.getByRole('button', { name: 'One more entry' }).click();
  await expect(page.getByTestId('entry-quantity')).toHaveText('3');
  await expect(page.getByTestId('entry-total')).toHaveText('£8.97');

  // No invented remaining-ticket count anywhere on the page.
  await expect(page.getByText(/remaining|left|sold/i)).toHaveCount(0);
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
