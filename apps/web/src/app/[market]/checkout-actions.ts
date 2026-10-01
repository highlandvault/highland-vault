'use server';

import { OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { ORDER_ID } from '@/lib/checkout';

/**
 * Checkout and payment actions (P6-8).
 *
 * **No business rule lives here.** The basket's contents, the terms version,
 * the skill answer, the per-person cap, the price, the currency, the payment
 * deadline and whether an attempt may be started are all decided by the API,
 * which holds them under the same locks that made them true in the first
 * place. These functions forward a form and route the answer.
 *
 * In particular, nothing in this file can make an order paid. There is no such
 * call to make: confirmation arrives by verified webhook or a trusted provider
 * status check, server-side, and a browser is neither.
 */

/** A key the checkout page minted for one render of the form. */
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Back to checkout with a refusal the customer can read.
 *
 * The fragment is what moves them to it. The page gives the banner that id and
 * a `tabIndex`, so the browser scrolls to it and focuses it on arrival —
 * without JavaScript, which is the only way this page is allowed to work.
 */
function refuse(checkout: string, code: string): never {
  redirect(`${checkout}?error=${code}#checkout-error`);
}

export async function placeOrder(market: string, form: FormData): Promise<void> {
  if (!isMarketCode(market)) redirect('/');
  const checkout = `/${market}/checkout`;

  const rawTerms = form.get('termsVersion');
  const termsVersion = typeof rawTerms === 'string' ? rawTerms : '';
  /**
   * ONE RENDER, ONE KEY — and therefore one order.
   *
   * It comes from the form rather than being minted here, so a double click,
   * a resubmitted page or a back-then-submit is the same request to the API.
   * It replays the order it already made instead of finding the basket its own
   * first attempt emptied and refusing it as empty, which is what a fresh key
   * per submission used to produce.
   *
   * Trusting the form with it is safe because the API does not trust it: the
   * key is bound to a digest of the buyer and the exact purchase, so reusing
   * one for different contents is refused and one belonging to somebody else
   * matches nothing. A missing or malformed value is simply a request that
   * does not get the replay, never one that gets somebody else's order.
   */
  const supplied = form.get('idempotencyKey');
  const idempotencyKey =
    typeof supplied === 'string' && IDEMPOTENCY_KEY.test(supplied) ? supplied : randomUUID();
  // One entry per basket line, each naming its draw and — where the draw asks
  // a question — the option the customer chose. The API checks every one of
  // them against the basket it holds (ADR-0032).
  const items = form
    .getAll('item')
    .map((raw) => {
      const [slug, quantity] = (typeof raw === 'string' ? raw : '').split('|');
      // The answer, when this draw asked one. Absent is a real case, and the
      // API decides whether it was required.
      const answer = slug ? form.get(`answer-${slug}`) : null;
      return {
        slug: slug ?? '',
        quantity: Number(quantity),
        ...(typeof answer === 'string' && answer.length > 0 ? { optionId: answer } : {}),
      };
    })
    .filter((item) => item.slug.length > 0 && Number.isInteger(item.quantity));

  if (items.length === 0) redirect(`/${market}/basket`);

  // Agreement is a RECORD, not a checkbox. The API stores the acceptance
  // against the version the customer was shown and then re-checks it when the
  // order is created — so ticking the box here means asking the API to record
  // it, and a stale page agreeing to superseded terms is refused rather than
  // believed.
  if (form.get('acceptTerms') === 'yes') {
    const accepted = await apiFetch(`/markets/${market}/terms/acceptance`, {
      method: 'POST',
      body: { version: termsVersion },
    });
    if (!accepted.ok) {
      if (accepted.status === 401) redirect(`/login?next=${encodeURIComponent(checkout)}`);
      refuse(checkout, accepted.code);
    }
  }

  const result = await apiFetch(`/markets/${market}/checkout/orders`, {
    method: 'POST',
    body: { items, termsVersion },
    headers: { 'idempotency-key': idempotencyKey },
    parse: (json) => OrderResponseSchema.parse(json).order,
  });
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=${encodeURIComponent(checkout)}`);
    refuse(checkout, result.code);
  }
  redirect(`/${market}/orders/${result.data.id}`);
}

/**
 * Starts a payment, or returns to the one already in progress.
 *
 * D3b = A is the API's rule, not this function's: asking again for an order
 * that already has a live attempt hands back **that** attempt's provider page,
 * never a second one. All this does is follow where it is sent.
 */
export async function startPayment(market: string, orderId: string): Promise<void> {
  if (!isMarketCode(market) || !ORDER_ID.test(orderId)) redirect('/');
  const orderPath = `/${market}/orders/${orderId}`;

  const result = await apiFetch(`/markets/${market}/checkout/orders/${orderId}/payments`, {
    method: 'POST',
    body: {},
    headers: { 'idempotency-key': randomUUID() },
    parse: (json) => PaymentResponseSchema.parse(json).payment,
  });
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=${encodeURIComponent(orderPath)}`);
    redirect(`${orderPath}?error=${result.code}`);
  }
  // Off to the provider. Everything that happens next happens on their site,
  // and what comes back is a claim, never a confirmation.
  redirect(result.data.redirectUrl);
}
