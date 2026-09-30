import { expect, test } from '@playwright/test';
import { E2E_RESERVATION_TTL_SECONDS } from '../playwright.config';
import { registerCustomer } from './fixtures';

// Reservation edge cases (desktop only; the main journey also runs on mobile in draws.spec.ts).
// Uses the seeded test draws: highland-lodge-escape (4,000 tickets) and last-tickets (4 tickets).

async function reserve(page: import('@playwright/test').Page, slug: string, quantity: number) {
  await page.goto(`/uk/draws/${slug}`);
  for (let i = 1; i < quantity; i++) {
    await page.getByRole('button', { name: 'One more entry' }).click();
  }
  await expect(page.getByTestId('entry-quantity')).toHaveText(String(quantity));
  await page.getByRole('button', { name: 'Add to basket' }).click();
  // Basket-first since P6-8. The hold is real and its own page still shows the
  // ticket numbers, so the reservation assertions below are unchanged.
  await expect(page).toHaveURL(/\/uk\/basket$/);
  await page.getByTestId('basket-line-tickets').last().click();
  await expect(page).toHaveURL(/\/uk\/reservations\/[0-9a-f-]{36}$/);
  return page.url();
}

test('when the tickets run out first, the customer is told and nothing is reserved', async ({
  page,
  browser,
}) => {
  // This customer chooses 3 of the 4 tickets…
  await registerCustomer(page, 'late');
  await page.goto('/uk/draws/last-tickets');
  await expect(page.getByTestId('availability')).toContainText('4 of 4 tickets available');
  await page.getByRole('button', { name: 'One more entry' }).click();
  await page.getByRole('button', { name: 'One more entry' }).click();
  await expect(page.getByTestId('entry-total')).toHaveText('£15.00');

  // …while someone else reserves 2 of them.
  const other = await browser.newContext();
  const rival = await other.newPage();
  try {
    await registerCustomer(rival, 'early');
    const rivalReservation = await reserve(rival, 'last-tickets', 2);

    await page.getByRole('button', { name: 'Add to basket' }).click();
    await expect(page.getByTestId('entry-error')).toHaveText(
      'There are not enough tickets left for that many entries. Choose fewer and try again.',
    );
    await expect(page).toHaveURL(/\/uk\/draws\/last-tickets\?error=INSUFFICIENT_TICKETS/);
    // No partial reservation: both remaining tickets are still available.
    await expect(page.getByTestId('availability')).toContainText('2 of 4 tickets available');
    // The stepper now stops at what is left.
    await page.getByRole('button', { name: 'One more entry' }).click();
    await expect(page.getByTestId('entry-quantity')).toHaveText('2');
    await expect(page.getByRole('button', { name: 'One more entry' })).toBeDisabled();

    // Releasing gives the tickets straight back.
    await rival.goto(rivalReservation);
    await rival.getByRole('button', { name: 'Release these tickets' }).click();
    await expect(rival.getByTestId('reservation-title')).toHaveText(
      'You released this reservation',
    );
    await page.goto('/uk/draws/last-tickets');
    await expect(page.getByTestId('availability')).toContainText('4 of 4 tickets available');
  } finally {
    await other.close();
  }
});

test('an expired reservation shows as expired, by itself, and the tickets return', async ({
  page,
}) => {
  test.setTimeout((E2E_RESERVATION_TTL_SECONDS + 90) * 1000);
  await registerCustomer(page, 'expiry');
  await reserve(page, 'highland-lodge-escape', 2);
  await expect(page.getByTestId('ticket-number')).toHaveCount(2);

  /*
   * Every refresh across the expiry boundary is made to fail, deliberately.
   *
   * The countdown used to refresh exactly once when it reached zero and then
   * never again, so a single refresh that came back without the answer left
   * the page reading "Your tickets are reserved" for good. That happens for
   * ordinary reasons: the server decides expiry by comparing `expires_at <=
   * now()` on each read, so a refresh issued a moment early is answered
   * `active` and is right to be; and the render behind it calls the API, which
   * can be slow or briefly unreachable.
   *
   * Waiting for that race to go the wrong way is what made this test flaky.
   * Instead the window is forced: from ten seconds before the deadline until
   * ten after, every refresh is aborted. The page can therefore only reach
   * "expired" by asking again once the window closes — which is exactly the
   * behaviour being added, and which the old once-only refresh could not do.
   */
  const RESERVATION_URL = /\/uk\/reservations\/[0-9a-f-]{36}/;

  /*
   * The deadline is read from the page once and then waited out by the test
   * runner, not by watching the countdown.
   *
   * Watching it was a mistake: under a loaded suite the renderer is starved,
   * the interval stops firing, and the clock sits at whatever it last
   * displayed — one run had it reading 3:47 after five minutes of real time,
   * with Playwright managing six DOM reads in that window. Waiting on a value
   * the page may never paint makes this test a load meter. `waitForTimeout`
   * is driven from outside the browser and measures the same thing regardless.
   */
  const deadline = Date.parse(
    (await page.locator('time[datetime]').first().getAttribute('datetime'))!,
  );
  await page.waitForTimeout(Math.max(0, deadline - Date.now() - 8_000));

  let aborted = 0;
  await page.route(RESERVATION_URL, async (route, request) => {
    // Navigations are the customer's own; only the background refreshes matter.
    if (request.isNavigationRequest()) return route.continue();
    aborted++;
    return route.abort('failed');
  });
  // Across zero: the refresh at the boundary and at least one retry after it
  // are both lost.
  await page.waitForTimeout(20_000);
  await page.unroute(RESERVATION_URL);

  /*
   * With the window closed, the next attempt gets through — and there has to
   * BE a next attempt. Before this change the countdown refreshed once at zero
   * behind a flag it never cleared, so every refresh above would have been the
   * only one and this page would still read "Your tickets are reserved".
   *
   * Nothing here reloads the page: this is the countdown asking again.
   */
  await expect(page.getByTestId('reservation-title')).toHaveText('This reservation has expired', {
    timeout: 90_000,
  });
  expect(aborted, 'the boundary refreshes were the ones aborted').toBeGreaterThan(0);
  await expect(page.getByTestId('ticket-number')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Release these tickets' })).toHaveCount(0);

  // The allowance is back in full.
  await page.getByRole('link', { name: 'Back to the draw' }).click();
  await expect(page).toHaveURL(/\/uk\/draws\/highland-lodge-escape$/);
  await expect(page.getByTestId('availability')).toBeVisible();
  await expect(page.getByText(/left for you/)).toHaveCount(0);
});

test('a reservation belongs to its customer and its market', async ({ page, browser }) => {
  await registerCustomer(page, 'owner');
  const url = await reserve(page, 'highland-lodge-escape', 1);
  const id = url.split('/').pop()!;

  // Not reachable through another market, nor through Germany (disabled).
  expect((await page.goto(`/ie/reservations/${id}`))?.status()).toBe(404);
  expect((await page.goto(`/de/reservations/${id}`))?.status()).toBe(404);
  expect((await page.goto('/uk/reservations/not-a-reservation'))?.status()).toBe(404);

  // Another customer cannot see it (or release it).
  const other = await browser.newContext();
  const stranger = await other.newPage();
  try {
    await registerCustomer(stranger, 'stranger');
    expect((await stranger.goto(url))?.status()).toBe(404);
    await expect(stranger.getByTestId('ticket-number')).toHaveCount(0);
  } finally {
    await other.close();
  }

  // Signed out, the page asks for sign-in and shows nothing.
  const anonymous = await browser.newContext();
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(url);
    await expect(visitor).toHaveURL(/\/login\?next=%2Fuk%2Freservations%2F/);
  } finally {
    await anonymous.close();
  }

  await page.goto(url);
  await expect(page.getByTestId('reservation-title')).toHaveText('Your tickets are reserved');
});
