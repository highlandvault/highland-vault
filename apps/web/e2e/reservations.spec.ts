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
  await page.getByRole('button', { name: 'Reserve tickets' }).click();
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

    await page.getByRole('button', { name: 'Reserve tickets' }).click();
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
  test.setTimeout((E2E_RESERVATION_TTL_SECONDS + 60) * 1000);
  await registerCustomer(page, 'expiry');
  await reserve(page, 'highland-lodge-escape', 2);
  await expect(page.getByTestId('ticket-number')).toHaveCount(2);

  // No reload: the countdown reaches zero and asks the server, which says expired.
  await expect(page.getByTestId('reservation-title')).toHaveText('This reservation has expired', {
    timeout: (E2E_RESERVATION_TTL_SECONDS + 20) * 1000,
  });
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
