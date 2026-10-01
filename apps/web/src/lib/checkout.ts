import 'server-only';
import {
  type Cart,
  CartResponseSchema,
  type Order,
  OrderResponseSchema,
  type MarketTermsResponse,
  MarketTermsResponseSchema,
} from '@hv/contracts';
import { apiFetch } from './api';

// The refusal wording lives in its own module: it is pure presentation, and
// this one is `server-only`, which a unit test cannot import.
export { checkoutErrorMessage, SHOWN_ERROR_CODES, type ShownErrorCode } from './checkout-errors';

/**
 * Basket, order and payment data for the customer pages (P6-8).
 *
 * Everything here is the API's answer, unaltered. The web app holds no basket
 * of its own, computes no total, decides no eligibility and knows nothing
 * about the per-person cap — those live behind the API with the locks and the
 * database constraints that make them true. This module's whole job is to ask
 * and to report.
 */

export const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The caller's basket for this market. Empty is a normal answer, not an error. */
export async function fetchCart(market: string): Promise<Cart | null> {
  const result = await apiFetch(`/markets/${market}/cart`, {
    parse: (json) => CartResponseSchema.parse(json).cart,
  });
  return result.ok ? result.data : null;
}

/** The market's active terms, which checkout must show and the API then re-checks. */
export async function fetchTerms(market: string): Promise<MarketTermsResponse | null> {
  const result = await apiFetch(`/markets/${market}/terms`, {
    parse: (json) => MarketTermsResponseSchema.parse(json),
  });
  return result.ok ? result.data : null;
}

export type OrderLookup =
  | { ok: true; order: Order }
  | { ok: false; reason: 'not_found' | 'signed_out' | 'verification_required' };

/** The caller's own order. Somebody else's is simply not found. */
export async function fetchOrder(market: string, id: string): Promise<OrderLookup> {
  if (!ORDER_ID.test(id)) return { ok: false, reason: 'not_found' };
  const result = await apiFetch(`/markets/${market}/checkout/orders/${id}`, {
    parse: (json) => OrderResponseSchema.parse(json).order,
  });
  if (result.ok) return { ok: true, order: result.data };
  if (result.status === 401) return { ok: false, reason: 'signed_out' };
  if (result.code === 'VERIFICATION_REQUIRED') {
    return { ok: false, reason: 'verification_required' };
  }
  return { ok: false, reason: 'not_found' };
}
