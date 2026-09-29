import { expect, test, type Page, type Response } from '@playwright/test';
import { registerCustomer } from './fixtures';

/**
 * The purchase journey, end to end in a real browser (P6-8).
 *
 * Draw → basket → checkout → order → payment, the real return link, and then
 * the part that matters most: **coming back from the provider proves nothing.**
 * Gate 4.1 asks for exactly that, and the last two tests here are its browser
 * half.
 *
 * The seeded draws ask "what is 2 + 3?", so the test answers the way a
 * customer does — by reading the question. The correct option never leaves the
 * API, and nothing here asks it to.
 */

const RIGHT = '5';
const WRONG = '4';

/** The return page answers 404 for every caller without a usable link. */
const REFUSED = 404;

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

/**
 * Clicks Pay and returns the provider URL the browser was sent to.
 *
 * The fake provider's host is `.invalid`, which by RFC 6761 can never resolve
 * — that is the point, because it proves the payment reached the provider
 * boundary and no further. The navigation therefore **fails**, and the failure
 * has to be awaited: firing the next `goto` while Chrome is still settling on
 * its error page is what interrupts it with `chrome-error://chromewebdata/`.
 *
 * So both halves are awaited explicitly — the request leaving, and the frame
 * finishing whatever it does with it — rather than slept through or hoped for.
 */
async function payAndCaptureProviderUrl(page: Page): Promise<string> {
  // The provider's host is `.invalid`, which by RFC 6761 can never resolve.
  // That is deliberate — it proves the payment reached the provider boundary
  // and went no further — but a navigation that fails DNS never commits, so
  // there is no navigation event to await and the next goto races it unwinding.
  // Routing the request stops the browser attempting DNS at all: the API still
  // built the real provider url, the browser is still sent to it, and the
  // journey now ends somewhere deterministic instead of on an error page.
  await page.route('**/fake-provider.invalid/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Provider</title><p data-testid="provider-stub">Provider</p>',
    }),
  );
  try {
    const leaving = page.waitForRequest((r) => r.url().includes('fake-provider.invalid'));
    await page.getByTestId('order-pay').click();
    const request = await leaving;
    // The browser really did land there, and we waited for it properly.
    await page.waitForURL(/fake-provider.invalid/);
    await expect(page.getByTestId('provider-stub')).toBeVisible();
    return request.url();
  } finally {
    await page.unroute('**/fake-provider.invalid/**');
  }
}

/** The `t=` value the provider was handed, which is the real return link. */
function accessTokenFrom(providerUrl: string): string {
  const returnTo = new URL(providerUrl).searchParams.get('return_to');
  expect(returnTo, 'the provider was given a return url').toBeTruthy();
  const token = new URL(returnTo!).searchParams.get('t');
  expect(token, 'the return url carries the access token').toBeTruthy();
  return token!;
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

  // Paying leaves for the provider, and goes no further.
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-pay')).toBeVisible();
  const providerUrl = await payAndCaptureProviderUrl(page);
  expect(providerUrl).toContain('reference=');
  // The return address is the EXCHANGE route, which is the only place a cookie
  // can legally be set, and it carries the read-only access token (OD-2).
  const returnTo = new URL(providerUrl).searchParams.get('return_to')!;
  expect(returnTo).toContain('/return/exchange');
  expect(new URL(returnTo).searchParams.get('t')).toBeTruthy();

  // Whatever happened out there, the order has not moved.
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
});

test('the return link opens the order, and nothing else', async ({ page, context }) => {
  await registerCustomer(page, 'returning');
  const orderUrl = await buy(page, 'highland-lodge-escape', 1);
  const providerUrl = await payAndCaptureProviderUrl(page);
  // (1) The address the provider was given is the exchange, and it carries the
  // token: the one place the token is ever allowed to appear in a URL.
  expect(new URL(providerUrl).searchParams.get('return_to')).toContain('/return/exchange');
  const token = accessTokenFrom(providerUrl);

  // (2) The real mechanism, exercised through the browser exactly as a customer
  // coming back from a provider would. The status below is the clean page's,
  // reached through the redirect; a 404 there means the cookie never arrived,
  // which is precisely how this failed before.
  const seen: number[] = [];
  const record = (r: Response) => {
    if (r.url().includes('/return')) seen.push(r.status());
  };
  page.on('response', record);
  const response = await page.goto(
    `/checkout/payments/00000000-0000-4000-8000-000000000000/return/exchange?t=${token}`,
  );
  page.off('response', record);
  expect(response?.status(), 'the exchange succeeds').toBe(200);
  // (3) ...and it got there by a redirect, not by the exchange rendering a page.
  expect(seen[0], 'the exchange redirects rather than rendering').toBe(303);

  // (4) The cookie exists, and every attribute it was given survived. Secure is
  // absent only because this origin is plain HTTP; the same expression makes it
  // true over TLS, which is the condition the browser enforces anyway.
  const cookie = (await context.cookies()).find((c) => c.name === 'hv_order_access');
  expect(cookie, 'the exchange set the access cookie').toBeTruthy();
  expect(cookie!.value).toBe(token);
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(cookie!.path).toBe('/checkout/payments');

  // (5) Landed on the clean address, with the credential no longer in it.
  await expect(page).toHaveURL(/\/checkout\/payments\/[0-9a-f-]{36}\/return$/);
  expect(page.url()).not.toContain('t=');
  expect(page.url()).not.toContain(token);

  // (6, 7, 8) The page read the cookie server-side, the order-access GET
  // succeeded, and what it shows is the ORDER's status as the database holds
  // it — not the attempt's, and nothing from the URL.
  await expect(page.getByTestId('payment-return')).toBeVisible();
  await expect(page.getByTestId('return-status')).toContainText('waiting for the payment provider');
  await expect(page.getByTestId('return-total')).toHaveText('£2.99');

  // (9) HttpOnly: the token reached the browser and page JavaScript still
  // cannot see it. This is the assertion the API tests could never make.
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain('hv_order_access');
  expect(visible).not.toContain(token);

  // (10) Refreshing is still only reading. The page cannot reconcile, so no
  // number of visits finds the provider's answer early, let alone acts on it.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await expect(page.getByTestId('return-status')).toContainText(
      'waiting for the payment provider',
    );
  }

  // Reading the order changed nothing about it.
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
  await expect(page.getByTestId('order-status')).not.toContainText('Paid.');
  // And the link offers no way to pay: that is the order page's, and D18 = B
  // keeps it off the link deliberately.
  await page.goBack();
  await expect(page.getByTestId('order-pay')).toHaveCount(0);
});

test('coming back from the provider cannot mark an order paid (toward G4.1)', async ({ page }) => {
  await registerCustomer(page, 'returner');
  const orderUrl = await buy(page, 'highland-lodge-escape', 1);
  await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');

  const paymentId = '00000000-0000-4000-8000-000000000000';

  // Every shape a forged return could take. Each is REFUSED with the route's
  // own answer — never a 500, which would mean the page crashed rather than
  // refused. An earlier version of this test accepted anything >= 400 and so
  // could not tell those apart; it passed while the exchange was throwing.
  const forged: { url: string; final: number }[] = [
    // No credential at all.
    { url: `/checkout/payments/${paymentId}/return`, final: REFUSED },
    // A query string that simply claims success. The page reads cookies, not URLs.
    { url: `/checkout/payments/${paymentId}/return?status=paid&paid=true`, final: REFUSED },
    // A made-up token: the exchange accepts it into a cookie and the API
    // refuses it on the next breath, which is the same answer as expired.
    {
      url: `/checkout/payments/${paymentId}/return/exchange?t=not-a-real-token-value`,
      final: REFUSED,
    },
    // The exchange with nothing to exchange.
    { url: `/checkout/payments/${paymentId}/return/exchange`, final: REFUSED },
  ];
  for (const { url, final } of forged) {
    const response: Response | null = await page.goto(url);
    expect(response?.status(), `${url} must be refused, not crash`).toBe(final);
    // Explicit: a server error here means the route threw.
    expect(response?.status(), `${url} must not be a server error`).toBeLessThan(500);
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
