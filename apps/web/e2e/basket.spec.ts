import { expect, test, type Page } from '@playwright/test';
import { registerCustomer } from './fixtures';

/**
 * The basket (UI-4), in a real browser.
 *
 * ## Why one test carries the whole multi-line story
 *
 * A second basket line needs a second live UK draw, and the fixtures seed
 * exactly two: highland-lodge-escape (4,000 tickets, effectively unlimited for
 * a fresh customer) and last-tickets (four tickets, deliberately scarce so
 * reservations.spec.ts can run out of them). That spec asserts all four are
 * available at its start, and the suite is `fullyParallel` — so every basket
 * test that reserved from `last-tickets` would be racing it, and a handful of
 * them would empty the pool outright.
 *
 * So the multi-line behaviour — two lines, the combined total, a lapsed line,
 * removal — is one test holding a single `last-tickets` ticket for a few
 * seconds, and every other test here uses the lodge draw alone.
 *
 * ## Why none of these wait out a TTL
 *
 * A lapsed line is one whose reservation is no longer `active`, and releasing
 * a hold produces exactly that state at once: the engine ends the hold, and
 * nothing removes the basket row. So "a hold that is no longer live" is
 * reached in milliseconds rather than by sleeping through the reservation TTL.
 * The expiry path itself is already covered by reservations.spec.ts, which
 * pays that cost once.
 */

const LODGE = 'Highland lodge escape';
const LAST = 'Last tickets';

/** Adds one draw to the basket and lands on the basket. */
async function add(page: Page, slug: string, entries = 1): Promise<void> {
  await page.goto(`/uk/draws/${slug}`);
  for (let i = 1; i < entries; i++) {
    await page.getByRole('button', { name: 'One more entry' }).click();
  }
  await expect(page.getByTestId('entry-quantity')).toHaveText(String(entries));
  await page.getByRole('button', { name: 'Add to basket' }).click();
  await expect(page).toHaveURL(/\/uk\/basket$/);
}

/** The basket line for a given competition, by its title. */
function line(page: Page, title: string) {
  return page.getByTestId('basket-item').filter({ hasText: title });
}

/** Ends a line's hold through the reservation's own page, then comes back. */
async function releaseHold(page: Page, title: string): Promise<void> {
  await line(page, title).getByTestId('basket-line-tickets').click();
  await expect(page).toHaveURL(/\/uk\/reservations\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Release these tickets' }).click();
  await expect(page.getByTestId('reservation-title')).toHaveText('You released this reservation');
  await page.goto('/uk/basket');
}

test('two competitions, one combined total, and what happens as each line ends', async ({
  page,
}) => {
  await registerCustomer(page, 'basket-lines');
  await add(page, 'highland-lodge-escape', 2);
  await add(page, 'last-tickets', 1);

  // Two lines, each with its own total, and one total for the basket.
  await expect(page.getByTestId('basket-item')).toHaveCount(2);
  await expect(line(page, LODGE).getByTestId('basket-line-total')).toHaveText('£5.98');
  await expect(line(page, LAST).getByTestId('basket-line-total')).toHaveText('£5.00');
  // The API's total, printed as given — not a sum computed in the browser.
  await expect(page.getByTestId('basket-total')).toHaveText('£10.98');
  await expect(page.getByTestId('basket-checkout')).toBeEnabled();
  // Nothing has lapsed, so there is nothing to explain.
  await expect(page.getByTestId('basket-lapsed-note')).toHaveCount(0);

  await releaseHold(page, LAST);

  // Still listed — the customer put it there and it does not vanish — but
  // plainly no longer buyable, out of the total, and explained.
  await expect(page.getByTestId('basket-item')).toHaveCount(2);
  await expect(line(page, LAST).getByTestId('basket-line-expired')).toBeVisible();
  await expect(line(page, LODGE).getByTestId('basket-line-expired')).toHaveCount(0);
  await expect(page.getByTestId('basket-total')).toHaveText('£5.98');
  await expect(page.getByTestId('basket-lapsed-note')).toBeVisible();
  // A lapsed line offers the way back to the competition, and nothing more.
  await expect(
    line(page, LAST).getByRole('link', { name: 'Back to the competition' }),
  ).toBeVisible();
  // One line is still live, so checkout is still worth offering.
  await expect(page.getByTestId('basket-checkout')).toBeEnabled();

  // Removing one line leaves the other alone.
  await line(page, LAST).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('basket-item')).toHaveCount(1);
  await expect(line(page, LAST)).toHaveCount(0);
  await expect(line(page, LODGE)).toBeVisible();
  await expect(page.getByTestId('basket-total')).toHaveText('£5.98');

  // And when the last live hold ends, there is nothing left to buy.
  await releaseHold(page, LODGE);
  await expect(page.getByTestId('basket-line-expired')).toHaveCount(1);
  await expect(page.getByTestId('basket-total')).toHaveText('—');
  await expect(page.getByTestId('basket-checkout')).toBeDisabled();
  await expect(page.getByTestId('basket-lapsed-note')).toBeVisible();
});

test('removing the last line empties the basket', async ({ page }) => {
  await registerCustomer(page, 'basket-last-out');
  await add(page, 'highland-lodge-escape', 2);
  await expect(page.getByTestId('basket-item')).toHaveCount(1);
  await expect(page.getByTestId('basket-total')).toHaveText('£5.98');

  await page.getByRole('button', { name: 'Remove' }).click();

  await expect(page.getByTestId('basket-empty')).toBeVisible();
  await expect(page.getByTestId('basket-items')).toHaveCount(0);
  await expect(page.getByTestId('basket-checkout')).toHaveCount(0);
  await page.getByRole('link', { name: 'Browse competitions' }).click();
  await expect(page).toHaveURL(/\/uk\/draws$/);
});

test('a basket belongs to its market', async ({ page }) => {
  await registerCustomer(page, 'basket-market');
  await add(page, 'highland-lodge-escape', 1);
  await expect(page.getByTestId('basket-item')).toHaveCount(1);

  // Ireland is enabled and has a basket of its own, which is empty.
  await page.goto('/ie/basket');
  await expect(page.getByTestId('basket-empty')).toBeVisible();
  await expect(page.getByTestId('basket-item')).toHaveCount(0);

  // Germany is disabled, basket included.
  expect((await page.goto('/de/basket'))?.status()).toBe(404);

  // The UK basket is untouched by any of that.
  await page.goto('/uk/basket');
  await expect(page.getByTestId('basket-item')).toHaveCount(1);
});

test('the basket works on a narrow phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerCustomer(page, 'basket-mobile');
  await add(page, 'highland-lodge-escape', 3);

  await expect(page.getByTestId('basket-item')).toHaveCount(1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // The things a customer has to be able to reach are reachable.
  const checkout = page.getByTestId('basket-checkout');
  await expect(checkout).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove' });
  await expect(remove).toBeVisible();
  // A real tap target, not a hairline.
  const box = await remove.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);
});
