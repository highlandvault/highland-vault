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

/** What the customer is told when the API refuses something at checkout. */
const CHECKOUT_MESSAGES: Record<string, string> = {
  CART_EMPTY: 'Your basket is empty. Add a draw before checking out.',
  CART_CHANGED: 'Your basket changed while you were checking out. Look it over and try again.',
  TERMS_NOT_ACCEPTED: 'Accept the terms and conditions to continue.',
  TERMS_VERSION_MISMATCH:
    'The terms were updated while you were checking out. Read them again and accept to continue.',
  SKILL_ANSWER_REQUIRED: 'Answer the question for each draw to continue.',
  SKILL_ANSWER_INCORRECT:
    'That answer was not correct, so nothing has been bought and your basket is unchanged. Try again.',
  VERIFICATION_REQUIRED: 'Verify your email address to continue.',
  TICKET_CAP_EXCEEDED: 'That would take you past the limit for this draw.',
  RESERVATION_EXPIRED: 'Your tickets were held for too long and have been released.',
  ORDER_NOT_PAYABLE: 'This order is no longer awaiting payment.',
  PAYMENT_DEADLINE_PASSED: 'The time to pay for this order has passed.',
  PAYMENT_WINDOW_TOO_SHORT:
    'There is not enough time left to pay for this order. Add the tickets to your basket again.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Payments are temporarily unavailable. Try again in a moment.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  IDEMPOTENCY_KEY_REUSED: 'That checkout was already used. Start again from your basket.',
};

export function checkoutErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return CHECKOUT_MESSAGES[code] ?? 'Something went wrong. Try again.';
}
