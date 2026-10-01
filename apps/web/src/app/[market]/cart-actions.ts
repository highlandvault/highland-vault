'use server';

import { CartResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';

/**
 * Basket actions (P6-8).
 *
 * **Adding to the basket is a real allocation.** `CartService` takes the hold
 * through the same ticket engine, under the same locks and the same per-person
 * cap, as the direct reservation path always did — there is no second
 * reservation mechanism here and no second source of truth. What changed in
 * P6-8 is only which of the two existing endpoints the draw page calls, so
 * that what the customer holds can become an order: `POST /checkout/orders`
 * builds the order from the basket, and an order must match the basket exactly
 * (ADR-0032).
 *
 * These actions forward a choice and nothing else. Availability, the cap, the
 * price, the currency and the expiry are all the API's, and its answer is what
 * the customer sees.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function addToBasket(market: string, slug: string, form: FormData): Promise<void> {
  if (!isMarketCode(market) || !SLUG.test(slug) || slug.length > 80) redirect('/');
  const drawPath = `/${market}/draws/${slug}`;
  const quantity = Number(form.get('quantity'));

  const result = await apiFetch(`/markets/${market}/cart/items`, {
    method: 'POST',
    body: { slug, quantity },
    parse: (json) => CartResponseSchema.parse(json).cart,
  });
  if (!result.ok) {
    if (result.status === 401 || result.code === 'MFA_REQUIRED') {
      redirect(`/login?next=${encodeURIComponent(drawPath)}`);
    }
    redirect(`${drawPath}?error=${result.code}#entry`);
  }
  redirect(`/${market}/basket`);
}

export async function removeFromBasket(market: string, itemId: string): Promise<void> {
  if (!isMarketCode(market) || !UUID.test(itemId)) redirect('/');
  const basket = `/${market}/basket`;
  const result = await apiFetch(`/markets/${market}/cart/items/${itemId}`, { method: 'DELETE' });
  if (!result.ok && result.status === 401) {
    redirect(`/login?next=${encodeURIComponent(basket)}`);
  }
  redirect(result.ok ? basket : `${basket}?error=${result.code}`);
}
