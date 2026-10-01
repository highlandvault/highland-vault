import type { ErrorCode } from '@hv/contracts';

/**
 * Every refusal a customer can be shown on the basket, checkout or order page.
 *
 * ## Why this list exists as well as the map
 *
 * The map used to be a `Record<string, string>`, which let it drift away from
 * the API in both directions at once and told the compiler nothing. Six of its
 * keys — `CART_EMPTY`, `CART_CHANGED`, `TERMS_VERSION_MISMATCH`,
 * `SKILL_ANSWER_REQUIRED`, `SKILL_ANSWER_INCORRECT`, `RESERVATION_EXPIRED` —
 * were not in `ErrorCode` at all and were emitted nowhere, while the codes the
 * API really sends had no entry. The effect was worst exactly where it mattered
 * most: a wrong skill answer fell through to "Something went wrong."
 *
 * So the codes are listed here, `satisfies` the contract's own union, and the
 * map below is a TOTAL `Record` over that list. A code added to the list
 * without a sentence is a compile error; a code invented here is a compile
 * error against `ErrorCode`. Drift in either direction stops being silent.
 */
const SHOWN_CODES = [
  // --- checkout ---------------------------------------------------------
  'INVALID_SKILL_ANSWER',
  'BASKET_EMPTY',
  'CONFLICT',
  'TERMS_NOT_ACCEPTED',
  'TERMS_VERSION_STALE',
  'TERMS_UNAVAILABLE',
  'VERIFICATION_REQUIRED',
  'CHECKOUT_IDENTITY_REQUIRED',
  'PAYMENT_WINDOW_TOO_SHORT',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  // --- basket -----------------------------------------------------------
  'TICKET_CAP_EXCEEDED',
  'INSUFFICIENT_TICKETS',
  'DRAW_NOT_OPEN',
  'INVALID_QUANTITY',
  // --- the order page, which shares this helper -------------------------
  'ORDER_NOT_PAYABLE',
  'PAYMENT_DEADLINE_PASSED',
  'PAYMENT_PROVIDER_UNAVAILABLE',
  // --- shape and transport ----------------------------------------------
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'MARKET_NOT_AVAILABLE',
] as const satisfies readonly ErrorCode[];

/** The one code that is ours rather than the API's: the call never arrived. */
const UNREACHABLE = 'UNREACHABLE';

export type ShownErrorCode = (typeof SHOWN_CODES)[number] | typeof UNREACHABLE;

/**
 * What the customer is told, in their own terms.
 *
 * Total over `SHOWN_CODES`, so every listed code has a sentence of its own and
 * none of them can quietly fall back to the generic one.
 *
 * Two of these are load-bearing beyond their wording:
 *
 * `INVALID_SKILL_ANSWER` is the API's single answer to a wrong answer AND a
 * missing one (ADR-0030). Telling them apart here would hand a guesser the
 * difference the API refuses to give them, so there is one sentence and it
 * says what is true of both cases — nothing was bought, and the basket is
 * exactly as it was.
 *
 * `CONFLICT` covers every way the request and the basket can disagree,
 * including a hold that ran out. The API deliberately does not name which, so
 * neither does this: the remedy is the same in all of them.
 */
const MESSAGES: Record<ShownErrorCode, string> = {
  INVALID_SKILL_ANSWER:
    'That answer was not correct. Nothing has been bought and your basket is unchanged — check your answer and try again.',
  // True of an empty basket and of one whose holds have all run out, which is
  // the same answer the API gives for both.
  BASKET_EMPTY: 'There is nothing left in your basket to buy.',
  CONFLICT: 'Your basket changed while you were checking out. Look it over and try again.',
  TERMS_NOT_ACCEPTED: 'Accept the terms and conditions to continue.',
  TERMS_VERSION_STALE:
    'The terms changed while you were checking out. Read them again and accept to continue.',
  TERMS_UNAVAILABLE: 'This market cannot take orders yet.',
  VERIFICATION_REQUIRED: 'Verify your email address to continue.',
  CHECKOUT_IDENTITY_REQUIRED: 'Sign in to continue with your basket.',
  PAYMENT_WINDOW_TOO_SHORT:
    'Your tickets are too close to being released to pay for them now. Add them to your basket again.',
  IDEMPOTENCY_KEY_REUSED: 'That checkout was already used. Start again from your basket.',
  IDEMPOTENCY_KEY_REQUIRED: 'That checkout could not be completed. Start again from your basket.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  SERVICE_UNAVAILABLE: 'We could not reach part of the service. Try again in a moment.',
  TICKET_CAP_EXCEEDED: 'That would take you past the limit for this draw.',
  INSUFFICIENT_TICKETS: 'There are not enough tickets left for that many entries.',
  DRAW_NOT_OPEN: 'That competition is not open for entries.',
  INVALID_QUANTITY: 'That number of entries is not allowed for this draw.',
  ORDER_NOT_PAYABLE: 'This order is no longer awaiting payment.',
  PAYMENT_DEADLINE_PASSED: 'The time to pay for this order has passed.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Payments are temporarily unavailable. Try again in a moment.',
  VALIDATION_FAILED: 'Something in that request was not valid. Start again from your basket.',
  NOT_FOUND: 'We could not find that. Start again from your basket.',
  MARKET_NOT_AVAILABLE: 'This market is not open at the moment.',
  [UNREACHABLE]: 'We could not reach the service. Try again in a moment.',
};

/** The codes this module promises a specific sentence for; exported for its test. */
export const SHOWN_ERROR_CODES: readonly ShownErrorCode[] = [...SHOWN_CODES, UNREACHABLE];

/**
 * The sentence for a refusal, or the generic one.
 *
 * The parameter stays `string` because it arrives from a query string, where
 * anybody can put anything — an unknown value is a stranger's guess, not a
 * code, and it gets the generic answer rather than being trusted.
 */
export function checkoutErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code as ShownErrorCode] ?? 'Something went wrong. Try again.';
}
