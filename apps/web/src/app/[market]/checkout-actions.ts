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

export async function placeOrder(market: string, form: FormData): Promise<void> {
  if (!isMarketCode(market)) redirect('/');
  const checkout = `/${market}/checkout`;

  const rawTerms = form.get('termsVersion');
  const termsVersion = typeof rawTerms === 'string' ? rawTerms : '';
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
      redirect(`${checkout}?error=${accepted.code}`);
    }
  }

  const result = await apiFetch(`/markets/${market}/checkout/orders`, {
    method: 'POST',
    body: { items, termsVersion },
    // A fresh key per submission: this is one attempt to buy, and the API
    // refuses a key reused for different contents.
    headers: { 'idempotency-key': randomUUID() },
    parse: (json) => OrderResponseSchema.parse(json).order,
  });
  if (!result.ok) {
    if (result.status === 401) redirect(`/login?next=${encodeURIComponent(checkout)}`);
    redirect(`${checkout}?error=${result.code}`);
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
