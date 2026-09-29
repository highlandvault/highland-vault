import { expect, test, type Page } from '@playwright/test';
import { registerCustomer } from './fixtures';

/**
 * The purchase journey, end to end in a real browser (P6-8).
 *
 * Draw → basket → checkout → order → payment, and then the part that matters
 * most: **coming back from the provider proves nothing.** Gate 4.1 asks for
 * exactly that, and the second test here is its browser half.
 *
 * The seeded draws ask "what is 2 + 3?", so the test answers the way a
 * customer does — by reading the question. The correct option never leaves the
 * API, and nothing here asks it to.
 */

const RIGHT = '5';
const WRONG = '4';

async function answerAndSubmit(page: Page, label: string) {
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('checkbox').check();
  await page.getByTestId('checkout-submit').click();
}

/** Draw → basket → checkout → order. Returns the order page's URL. */
async function buy(page: Page, slug: string, entries: number): Promise<string> {
  await page.goto(`/uk/draws/${slug}`);
  for (let i = 1; i < entries; i++) {
    await page.getByRole('button', { name: 'One more entry' }).click();
  }
  await page.getByRole('button', { name: 'Add to basket' }).click();
  await expect(page).toHaveURL(/\/uk\/basket$/);
  await page.getByTestId('basket-checkout').click();
  await expect(page).toHaveURL(/\/uk\/checkout$/);
  await answerAndSubmit(page, RIGHT);
  await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
  return page.url();
}

test('a customer buys: draw → basket → checkout → order → payment', async ({ page }) => {
  await registerCustomer(page, 'buyer');

  await page.goto('/uk/draws/highland-lodge-escape');
  await page.getByRole('button', { name: 'One more entry' }).click();
  await expect(page.getByTestId('entry-total')).toHaveText('£5.98');

  // Add to basket: a real hold, taken by the same ticket engine as before.
  await page.getByRole('button', { name: 'Add to basket' }).click();
  await expect(page).toHaveURL(/\/uk\/basket$/);
  await expect(page.getByTestId('basket-item')).toHaveCount(1);
  await expect(page.getByTestId('basket-total')).toHaveText('£5.98');
  // The hold is running, counted by the server's clock.
  await expect(page.getByTestId('countdown')).toHaveText(/^\d{1,2}:\d{2}$/);

  await page.getByTestId('basket-checkout').click();
  await expect(page).toHaveURL(/\/uk\/checkout$/);
  await expect(page.getByTestId('checkout-total')).toHaveText('£5.98');
  await expect(page.getByTestId('skill-prompt')).toContainText('2 + 3');

  // A wrong answer buys nothing at all (ADR-0030): no order, and the basket
  // and its hold are exactly as they were.
  await answerAndSubmit(page, WRONG);
  await expect(page).toHaveURL(/\/uk\/checkout\?error=/);
  await expect(page.getByTestId('checkout-error')).toBeVisible();
  await page.goto('/uk/basket');
  await expect(page.getByTestId('basket-item')).toHaveCount(1);
  await expect(page.getByTestId('basket-total')).toHaveText('£5.98');

  // The right answer places the order.
  await page.getByTestId('basket-checkout').click();
  await answerAndSubmit(page, RIGHT);
  await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = page.url();
  await expect(page.getByTestId('order-total')).toHaveText('£5.98');
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
  // The countdown runs to the ORDER's deadline, which D1 = B puts 90 seconds
  // before the hold expires — so it can never outlive the tickets.
  await expect(page.getByTestId('countdown')).toHaveText(/^\d{1,2}:\d{2}$/);

  // The basket is emptied by the order: those tickets belong to it now.
  await page.goto('/uk/basket');
  await expect(page.getByTestId('basket-empty')).toBeVisible();

  // Paying leaves for the provider. Its domain does not resolve, which is the
  // point — nothing on our side has been told anything.
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-pay')).toBeVisible();
  const leaving = page
    .waitForRequest((r) => r.url().includes('fake-provider.invalid'), { timeout: 15_000 })
    .catch(() => null);
  await page
    .getByTestId('order-pay')
    .click()
    .catch(() => null);
  const request = await leaving;
  if (request) {
    // The provider was handed a reference and a return url, and the return url
    // carries the read-only order access token (OD-2).
    expect(request.url()).toContain('reference=');
    expect(decodeURIComponent(request.url())).toContain('/return?t=');
  }

  // Whatever happened out there, the order has not moved.
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
});

test('coming back from the provider cannot mark an order paid (toward G4.1)', async ({ page }) => {
  await registerCustomer(page, 'returner');
  const orderUrl = await buy(page, 'highland-lodge-escape', 1);
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');

  const paymentId = '00000000-0000-4000-8000-000000000000';

  // Every shape a forged return could take: no token at all, a made-up token,
  // and a query string that simply claims success. None is an input to
  // anything — the page has no way to assert an outcome.
  for (const url of [
    `/checkout/payments/${paymentId}/return`,
    `/checkout/payments/${paymentId}/return?t=not-a-real-token-value-at-all`,
    `/checkout/payments/${paymentId}/return?status=paid&paid=true`,
  ]) {
    const response = await page.goto(url);
    expect(response?.status()).toBeGreaterThanOrEqual(400);
  }

  // Repeated visits and refreshes change nothing either.
  for (let i = 0; i < 3; i++) {
    await page.goto(orderUrl);
    await page.reload();
  }
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
  await expect(page.getByTestId('order-status')).not.toContainText('Paid.');

  // And the cancel page, which carries no credential at all, charges nothing
  // and claims nothing.
  await page.goto(`/checkout/payments/${paymentId}/cancel`);
  await expect(page.getByTestId('cancel-status')).toContainText('nothing has been charged');
});
