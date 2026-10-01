import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { E2E_API_ENV, E2E_API_URL } from '../playwright.config';
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

/** The provider's own reference for the attempt, as the redirect carries it. */
function providerReferenceFrom(providerUrl: string): string {
  const reference = new URL(providerUrl).searchParams.get('reference');
  expect(reference, 'the provider redirect names its reference').toBeTruthy();
  return reference!;
}

/**
 * Confirms a payment the way the real thing does: a signed provider webhook.
 *
 * This is the only route by which an order becomes paid in a browser test, and
 * it is deliberately the **real** one — the actual `/webhooks/payments/fake`
 * endpoint, the actual signature check, the actual intake and finalisation
 * transaction. Nothing here writes to the database, and no internal or
 * reconciliation route is called from a test pretending to be a browser.
 *
 * The signature is computed here rather than imported because `@hv/payments`
 * is not a dependency of the web app and adding one for a test would be a
 * build-config change in aid of a fixture. The scheme it mirrors lives in
 * `packages/payments/src/webhook-signature.ts`: HMAC-SHA256 over the exact
 * bytes, hex, in `x-hv-fake-signature`. The bytes are serialised once and
 * posted unchanged, because a re-serialisation would break the signature —
 * which is precisely the property P6-3 was built against.
 *
 * The amount must be what the ORDER is owed. A different figure is recorded as
 * an `amount_mismatch` and changes nothing, so a wrong amount here shows up as
 * a test that never reaches `paid` rather than as a false pass.
 */
async function confirmByWebhook(
  page: Page,
  providerReference: string,
  amountMinor: number,
  currency: 'GBP' | 'EUR' = 'GBP',
): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      id: `evt-${randomUUID()}`,
      type: 'payment.succeeded',
      reference: providerReference,
      state: 'succeeded',
      amountMinor,
      currency,
      occurredAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const signature = createHmac('sha256', E2E_API_ENV.FAKE_PAYMENT_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  // Straight to the API, not through the web app: a provider does not go
  // through anybody's browser. No Origin is sent and none is needed — this is
  // the one route exempt from the CSRF guard, because a provider has no origin
  // to offer.
  const response = await page.request.post(`${E2E_API_URL}/webhooks/payments/fake`, {
    headers: { 'content-type': 'application/json', 'x-hv-fake-signature': signature },
    data: body,
  });
  // A provider is told nothing but that the delivery was accepted.
  expect(response.status(), 'the webhook was accepted').toBe(200);
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

// ===========================================================================
// UI-5: the checkout page itself.
//
// The tests above cover the journey and the payment boundary. These cover what
// checkout says and does when something is wrong — which, before UI-5, was
// mostly "Something went wrong. Try again." because the error map held codes
// the API never sends.
//
// ## The four-ticket fixture
//
// Only ONE test here takes a `last-tickets` entry, and only one. That draw has
// four tickets in total and `reservations.spec.ts` asserts all four are free
// at its start, so every extra consumer in a `fullyParallel` suite is a race
// against it. Two basket lines need two live draws and the fixtures seed only
// two, so the multi-line case is deliberately a single test holding a single
// ticket for a few seconds.
//
// ## Why these share one account, in order
//
// Registering is limited to twenty attempts per hour per IP (B19), and every
// e2e test reaches the API from 127.0.0.1 — `TRUST_PROXY` is empty, so there
// is no header that could say otherwise and no way for a test to present a
// different address. The suite was already using sixteen of those twenty
// before UI-5; ten more registrations put it over, and the tests that drew the
// short straw failed on `/register?error=RATE_LIMITED` — including tests in
// other files that had nothing to do with this change.
//
// So this block registers ONE customer and runs serially against it, which
// costs one of the twenty instead of ten. Each test leaves the basket as it
// found it. The ceiling itself is reported to the owner rather than worked
// around any further: at sixteen of twenty, the suite had no room for a
// feature's worth of coverage, and that is a fixture problem rather than a
// checkout one.
// ===========================================================================

/** The one sentence a refused skill answer may ever produce (ADR-0030). */
const ANSWER_REFUSED =
  'That answer was not correct. Nothing has been bought and your basket is unchanged — check your answer and try again.';

test.describe('checkout', () => {
  // Serial: they share one signed-in customer, so they must not overlap.
  test.describe.configure({ mode: 'serial' });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await registerCustomer(page, 'ui5-checkout');
  });

  test.afterAll(async () => {
    await context.close();
  });

  /**
   * Leaves the basket empty, whatever the last test left in it.
   *
   * Reloaded between removals on purpose. A live line carries a countdown that
   * reticks every second, so the row never settles and a second click lands on
   * an element the re-render has already replaced — Playwright reports it as
   * detached, having retried until the hook ran out of time. Taking one line
   * per freshly drawn page is slower by a navigation and never races.
   */
  async function clearBasket(): Promise<void> {
    for (let guard = 0; guard < 6; guard++) {
      await page.goto('/uk/basket');
      const lines = await page.getByTestId('basket-item').count();
      if (lines === 0) break;
      await page.getByRole('button', { name: 'Remove' }).first().click();
      await expect(page.getByTestId('basket-item')).toHaveCount(lines - 1);
    }
    await expect(page.getByTestId('basket-empty')).toBeVisible();
  }

  test.beforeEach(async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await clearBasket();
  });

  /** Puts a draw in the basket and stops on the checkout page. */
  async function toCheckout(slug: string, entries = 1): Promise<void> {
    await page.goto(`/uk/draws/${slug}`);
    for (let i = 1; i < entries; i++) {
      await page.getByRole('button', { name: 'One more entry' }).click();
    }
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await expect(page).toHaveURL(/\/uk\/basket$/);
    await page.getByTestId('basket-checkout').click();
    await expect(page).toHaveURL(/\/uk\/checkout$/);
  }

  /** Ticks the terms box, whatever state the page rendered it in. */
  async function acceptTerms(): Promise<void> {
    await page.getByTestId('checkout-accept-terms').check();
  }

  /*
   * FIRST in this block, and it has to be.
   *
   * Accepting is a RECORD, not a checkbox — the API stores it against the
   * version and re-reads it when the order is created. Once any test here has
   * accepted, this customer can never again be one who has not, and the server
   * half of this test would be checking nothing: an unticked box would simply
   * find the stored acceptance and let the order through, which is correct
   * behaviour and the opposite of what this asserts.
   */
  test('the terms have to be accepted, in the browser and on the server', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();

    // (1) An honest browser never sends it: native validation holds the form.
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/checkout$/);
    await expect(page.getByTestId('checkout-error')).toHaveCount(0);
    await expect(page.getByTestId('checkout-accept-terms')).not.toBeChecked();

    // (2) A client that ignores the attribute is refused by the API, and told
    // which thing to fix rather than "something went wrong".
    await page.evaluate(() => {
      document.querySelector('input[name="acceptTerms"]')?.removeAttribute('required');
    });
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByTestId('checkout-error')).toHaveText(
      'Accept the terms and conditions to continue.',
    );
    await expect(page).toHaveURL(/\/uk\/checkout\?error=TERMS_NOT_ACCEPTED/);
  });

  test('a wrong answer is refused in plain words, and the basket survives it', async () => {
    await toCheckout('highland-lodge-escape', 2);

    await page.getByRole('radio', { name: WRONG, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();

    // The exact sentence, not merely "an error happened".
    await expect(page.getByTestId('checkout-error')).toHaveText(ANSWER_REFUSED);
    await expect(page).toHaveURL(/\/uk\/checkout\?error=INVALID_SKILL_ANSWER/);
    // The browser was sent to the message, so a keyboard user lands on it.
    expect(page.url()).toContain('#checkout-error');

    // Nothing was bought and nothing was released: the hold is still running.
    await page.goto('/uk/basket');
    await expect(page.getByTestId('basket-item')).toHaveCount(1);
    await expect(page.getByTestId('basket-total')).toHaveText('£5.98');
    await expect(page.getByTestId('countdown')).toHaveText(/^\d{1,2}:\d{2}$/);
    await expect(page.getByTestId('basket-line-expired')).toHaveCount(0);
    // And the tickets are still ours to look at, so no order took them.
    await page.getByTestId('basket-line-tickets').click();
    await expect(page.getByTestId('ticket-number')).toHaveCount(2);
  });

  test('a missing answer is refused in exactly the same words as a wrong one', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await acceptTerms();

    // `required` stops an honest browser from sending this at all, which is why
    // it is removed here: the point is that the SERVER refuses it, and refuses
    // it identically. A client that does not enforce the attribute must learn
    // nothing a client that does would not.
    await page.evaluate(() => {
      document.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.removeAttribute('required');
      });
    });
    await page.getByTestId('checkout-submit').click();

    await expect(page.getByTestId('checkout-error')).toHaveText(ANSWER_REFUSED);
    await expect(page).toHaveURL(/\/uk\/checkout\?error=INVALID_SKILL_ANSWER/);
  });

  test('one wrong answer rejects the whole order, not just its line', async () => {
    // The only test here that touches the four-ticket draw: see the note above.
    await page.goto('/uk/draws/highland-lodge-escape');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await expect(page).toHaveURL(/\/uk\/basket$/);
    await page.goto('/uk/draws/last-tickets');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await expect(page).toHaveURL(/\/uk\/basket$/);

    await page.getByTestId('basket-checkout').click();
    await expect(page).toHaveURL(/\/uk\/checkout$/);
    await expect(page.getByTestId('checkout-line')).toHaveCount(2);

    // Right on the first line, wrong on the second.
    const lines = page.getByTestId('checkout-line');
    await lines.first().getByRole('radio', { name: RIGHT, exact: true }).check();
    await lines.last().getByRole('radio', { name: WRONG, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();

    // All or nothing: the correct line buys nothing either.
    await expect(page.getByTestId('checkout-error')).toHaveText(ANSWER_REFUSED);
    await page.goto('/uk/basket');
    await expect(page.getByTestId('basket-item')).toHaveCount(2);
    await expect(page.getByTestId('basket-line-expired')).toHaveCount(0);
  });

  test('submitting twice buys once', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();

    /*
     * The duplicate is the browser's own submission, sent a second time.
     *
     * Clicking twice cannot produce it — React drops a second submit while the
     * first is in flight, so that version of this test passes without testing
     * anything. Rebuilding the request by hand cannot produce it either: a
     * hydrated form's `action` is React's `javascript:` sentinel, not an address.
     *
     * So the real request is captured as it leaves and replayed verbatim: same
     * endpoint, same headers, same body — and therefore the same
     * `idempotencyKey`, which is exactly what a second click or a resubmitted
     * page sends.
     */
    let sent: { url: string; headers: Record<string, string>; body: string } | null = null;
    page.on('request', (request) => {
      if (!sent && request.method() === 'POST' && request.url().includes('/uk/checkout')) {
        sent = { url: request.url(), headers: request.headers(), body: request.postData() ?? '' };
      }
    });

    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    const orderUrl = page.url();
    const orderId = orderUrl.split('/').pop()!;

    const captured = sent as unknown as {
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(captured, 'the submission was captured').toBeTruthy();
    expect(captured.body, 'it carried this render’s key').toContain('idempotencyKey');

    /*
     * Sent again from inside the page, not from the test runner.
     *
     * The API refuses a state-changing request that arrives without an allowed
     * `Origin`, which is the CSRF guard doing its job — and Playwright's request
     * context cannot set that header, so a replay from the runner is refused
     * before it ever reaches the idempotency check. The page's own `fetch`
     * carries the real origin and the session cookie, which is what a second
     * click would.
     */
    const replay = await page.evaluate(
      async ({
        url,
        headers,
        body,
      }: {
        url: string;
        headers: Record<string, string>;
        body: string;
      }) => {
        const send: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          // The browser sets these itself and refuses to be told.
          if (['content-length', 'host', 'connection', 'origin', 'referer'].includes(key)) continue;
          send[key] = value;
        }
        const response = await fetch(url, {
          method: 'POST',
          headers: send,
          body,
          credentials: 'include',
        });
        return { status: response.status, text: await response.text() };
      },
      captured,
    );

    // Answered, not refused — and above all never told the basket was empty,
    // which is what a freshly minted key per submission used to produce.
    expect(replay.status, 'the duplicate was answered').toBeLessThan(400);
    expect(replay.text, 'the duplicate replayed rather than refusing').not.toContain(
      'BASKET_EMPTY',
    );
    // It resolved to the SAME order: one purchase, not two.
    expect(replay.text, 'the duplicate resolved to the first order').toContain(orderId);

    // One order, one set of tickets: the basket was emptied once and stays empty.
    await page.goto('/uk/basket');
    await expect(page.getByTestId('basket-empty')).toBeVisible();
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-total')).toHaveText('£2.99');
    await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
  });

  test('a hold that ends between the page and the button is explained, not crashed', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();

    // The hold ends out of band — released here rather than waited out, which
    // reaches the same state in milliseconds instead of five minutes. The
    // checkout page in `page` is now describing a purchase that cannot happen.
    const other = await context.newPage();
    try {
      await other.goto('/uk/basket');
      await other.getByTestId('basket-line-tickets').click();
      await other.getByRole('button', { name: 'Release these tickets' }).click();
      await expect(other.getByTestId('reservation-title')).toHaveText(
        'You released this reservation',
      );
    } finally {
      await other.close();
    }

    await page.getByTestId('checkout-submit').click();

    /*
     * The customer ends up at the basket, and is told why.
     *
     * Checkout cannot show the message itself: with the hold gone there is
     * nothing live to check out, so the page sends them to the basket — where
     * the lapsed line is, and where the refusal is carried with them rather than
     * dropped on the way.
     */
    await expect(page).toHaveURL(/\/uk\/basket/);
    await expect(page.getByTestId('basket-error')).toBeVisible();
    await expect(page.getByTestId('basket-error')).not.toHaveText(
      'Something went wrong. Try again.',
    );
    // And the line is there, plainly lapsed, with nothing bought.
    await expect(page.getByTestId('basket-line-expired')).toHaveCount(1);
    await expect(page.getByTestId('basket-total')).toHaveText('—');
  });

  test('a basket cannot be checked out through another market', async () => {
    await toCheckout('highland-lodge-escape', 1);

    // Ireland has its own basket, which is empty — so there is nothing to check
    // out and the page says so by sending the customer to it.
    await page.goto('/ie/checkout');
    await expect(page).toHaveURL(/\/ie\/basket$/);
    await expect(page.getByTestId('basket-empty')).toBeVisible();

    // Germany is closed, checkout included.
    expect((await page.goto('/de/checkout'))?.status()).toBe(404);

    // The UK checkout is exactly as it was.
    await page.goto('/uk/checkout');
    await expect(page.getByTestId('checkout-line')).toHaveCount(1);
  });

  test('terms already accepted come back accepted', async () => {
    // By now this customer has accepted the active version — earlier tests in
    // this block did. The page reads that from the API rather than asking them
    // to agree to the same version twice, and says why the box is ticked.
    await toCheckout('highland-lodge-escape', 1);
    await expect(page.getByTestId('checkout-accept-terms')).toBeChecked();
    await expect(page.getByTestId('checkout-terms-accepted')).toBeVisible();
    // The version in force is still named, not merely implied.
    await expect(page.getByTestId('checkout-terms-version')).not.toBeEmpty();
  });

  test('checkout can be completed with the keyboard alone', async () => {
    await toCheckout('highland-lodge-escape', 1);

    // Every control is reached and operated by key, never by a click.
    await page.getByRole('radio', { name: RIGHT, exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('radio', { name: RIGHT, exact: true })).toBeChecked();

    // This customer has already accepted, so the box arrives ticked. Space is
    // still what operates it: toggled off, then on again, by key alone.
    const terms = page.getByTestId('checkout-accept-terms');
    await terms.focus();
    if (await terms.isChecked()) {
      await page.keyboard.press('Space');
      await expect(terms).not.toBeChecked();
    }
    await page.keyboard.press('Space');
    await expect(terms).toBeChecked();

    await page.getByTestId('checkout-submit').focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('order-status')).toContainText('Your tickets are held');
  });

  test('checkout works on a narrow phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await toCheckout('highland-lodge-escape', 3);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    // Answers are real targets, not default radio dots.
    const option = page.locator('.option').first();
    const box = (await option.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);

    const submit = page.getByTestId('checkout-submit');
    await expect(submit).toBeVisible();
    const cta = (await submit.boundingBox())!;
    expect(cta.height).toBeGreaterThanOrEqual(44);
    expect(Math.round(cta.x + cta.width)).toBeLessThanOrEqual(390);

    // And it still works at this size.
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await submit.click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
  });

  test('checkout and the order page each have exactly one main landmark', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    // One h1, and the sections below it are h2s.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  // ======================================================= UI-6: payment
  //
  // These share the block's one account for the same reason the rest do, and
  // they reach `paid` the only way anything may: a signed provider webhook
  // against the real endpoint.

  /** Order → provider → signed webhook → genuinely paid. Returns the order url. */
  async function payInFull(entries = 1): Promise<string> {
    await toCheckout('highland-lodge-escape', entries);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    const orderUrl = page.url();

    const providerUrl = await payAndCaptureProviderUrl(page);
    await confirmByWebhook(page, providerReferenceFrom(providerUrl), 299 * entries);
    return orderUrl;
  }

  test('a paid order says so, and says it because the webhook said so', async () => {
    const orderUrl = await payInFull(2);

    // The order page, read fresh. Nothing the browser did confirmed this: the
    // webhook did, server to server, and finalisation committed it.
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-status')).toContainText('Paid');
    await expect(page.getByTestId('order-total')).toHaveText('£5.98');
    // Paid orders are not payable, so the invitation is gone.
    await expect(page.getByTestId('order-pay')).toHaveCount(0);

    // The tickets are sold, so they are the customer's and they are listed.
    await expect(page.getByTestId('order-items')).toBeVisible();
  });

  test('the return page shows a paid order as paid', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);

    const providerUrl = await payAndCaptureProviderUrl(page);
    const token = accessTokenFrom(providerUrl);
    await confirmByWebhook(page, providerReferenceFrom(providerUrl), 299);

    // Back through the real exchange, exactly as a customer returns.
    await page.goto(
      `/checkout/payments/00000000-0000-4000-8000-000000000000/return/exchange?t=${token}`,
    );
    await expect(page).toHaveURL(/\/checkout\/payments\/[0-9a-f-]{36}\/return$/);
    await expect(page.getByTestId('return-status')).toContainText('Paid');
    await expect(page.getByTestId('return-total')).toHaveText('£2.99');
    // One landmark, and a heading structure that starts at h1.
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('a pending payment resolves itself, without the customer reloading', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);

    const providerUrl = await payAndCaptureProviderUrl(page);
    const token = accessTokenFrom(providerUrl);

    // Back from the provider BEFORE anything has confirmed: the honest pending
    // state, which is what a customer sees most of the time.
    await page.goto(
      `/checkout/payments/00000000-0000-4000-8000-000000000000/return/exchange?t=${token}`,
    );
    await expect(page).toHaveURL(/\/checkout\/payments\/[0-9a-f-]{36}\/return$/);
    await expect(page.getByTestId('return-status')).toContainText('Waiting');
    await expect(page.getByTestId('return-pending-note')).toBeVisible();
    // The watcher is running and says so out loud, politely.
    const watch = page.getByTestId('payment-watch');
    await expect(watch).toBeVisible();
    await expect(watch).toHaveAttribute('aria-live', 'polite');
    // Nothing is claimed while it waits.
    await expect(page.getByTestId('return-status')).not.toContainText('Paid');

    // The webhook lands while the customer sits on the page, touching nothing.
    await confirmByWebhook(page, providerReferenceFrom(providerUrl), 299);

    // No reload, no click: the watcher notices and the SERVER re-renders.
    await expect(page.getByTestId('return-status')).toContainText('Paid', { timeout: 20_000 });
    // The server re-rendered, so the waiting UI is gone with it.
    await expect(page.getByTestId('return-pending-note')).toHaveCount(0);
  });

  test('a customer sent back by a failure is invited to try again', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    const orderUrl = page.url();

    // The order is still payable, so the page offers the payment again rather
    // than reporting a failure the order never had.
    await page.goto(`${orderUrl}?error=PAYMENT_PROVIDER_UNAVAILABLE`);
    await expect(page.getByTestId('order-error')).toBeVisible();
    await expect(page.getByTestId('order-retry-note')).toBeVisible();
    const pay = page.getByTestId('order-pay');
    await expect(pay).toBeVisible();
    await expect(pay).toHaveText('Try again');
    // And the order has not moved: nothing about a refusal failed it.
    await expect(page.getByTestId('order-status')).toContainText('Awaiting payment');
  });

  test('the cancel page comes back to the order it belongs to', async () => {
    await toCheckout('highland-lodge-escape', 1);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);
    const orderUrl = page.url();

    const providerUrl = await payAndCaptureProviderUrl(page);
    const token = accessTokenFrom(providerUrl);
    const attemptId = new URL(new URL(providerUrl).searchParams.get('return_to')!).pathname.split(
      '/',
    )[3]!;

    // The access cookie exists only once they have come back once.
    await page.goto(
      `/checkout/payments/00000000-0000-4000-8000-000000000000/return/exchange?t=${token}`,
    );
    await expect(page).toHaveURL(/\/return$/);

    // Now the cancel address for that same attempt: it can prove which order
    // this is, so it links straight to it.
    await page.goto(`/checkout/payments/${attemptId}/cancel`);
    await expect(page.getByTestId('cancel-status')).toContainText('nothing has been charged');
    await page.getByTestId('cancel-order-link').click();
    await expect(page).toHaveURL(orderUrl);
    // Reaching cancel changed nothing: the order is still payable.
    await expect(page.getByTestId('order-pay')).toBeVisible();
  });

  test('the cancel page offers no order it cannot prove is yours', async () => {
    // A cancel address for an attempt the access cookie knows nothing about.
    await page.goto('/checkout/payments/00000000-0000-4000-8000-000000000000/cancel');
    await expect(page.getByTestId('cancel-status')).toBeVisible();
    await expect(page.getByTestId('cancel-order-link')).toHaveCount(0);
    await expect(page.getByTestId('cancel-account-link')).toBeVisible();
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('the payment pages carry one landmark and do not overflow a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await toCheckout('highland-lodge-escape', 2);
    await page.getByRole('radio', { name: RIGHT, exact: true }).check();
    await acceptTerms();
    await page.getByTestId('checkout-submit').click();
    await expect(page).toHaveURL(/\/uk\/orders\/[0-9a-f-]{36}$/);

    for (const check of ['order', 'return'] as const) {
      if (check === 'return') {
        const providerUrl = await payAndCaptureProviderUrl(page);
        const token = accessTokenFrom(providerUrl);
        await page.goto(
          `/checkout/payments/00000000-0000-4000-8000-000000000000/return/exchange?t=${token}`,
        );
        await expect(page).toHaveURL(/\/return$/);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${check} at 390px`).toBe(0);
      await expect(page.locator('main#main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
  });
});
