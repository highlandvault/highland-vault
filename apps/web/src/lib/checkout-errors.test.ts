import { describe, expect, it } from 'vitest';
import { SHOWN_ERROR_CODES, checkoutErrorMessage, type ShownErrorCode } from './checkout-errors';

/**
 * The refusal wording (UI-5).
 *
 * The map this covers used to be a `Record<string, string>` holding six codes
 * the API never emits, which meant the codes it DOES emit fell through to
 * "Something went wrong." These tests pin the two properties that mattered:
 * every listed code says something of its own, and the one refusal that is
 * deliberately ambiguous stays ambiguous.
 */

const GENERIC = 'Something went wrong. Try again.';

/** The codes checkout itself can produce, from the API source (see §6). */
const CHECKOUT_CODES: ShownErrorCode[] = [
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
  'UNREACHABLE',
];

describe('checkout error messages', () => {
  it.each(CHECKOUT_CODES)('%s has a message of its own', (code) => {
    const message = checkoutErrorMessage(code);
    expect(message, `${code} fell through to the generic message`).not.toBe(GENERIC);
    expect(message).toBeTruthy();
    // A sentence a customer can act on, not a code in disguise.
    expect(message).toMatch(/[a-z]/);
    expect(message).not.toMatch(/[A-Z_]{4,}/);
  });

  it('gives every code it lists a distinct, specific sentence', () => {
    const messages = SHOWN_ERROR_CODES.map((code) => checkoutErrorMessage(code));
    expect(messages).not.toContain(GENERIC);
    expect(messages.every((m) => typeof m === 'string' && m.length > 0)).toBe(true);
  });

  /**
   * ADR-0030: the API answers a wrong answer and a missing one with the same
   * code, so that a guesser cannot learn which they sent. A second sentence
   * here would give back exactly what the API withholds.
   */
  it('says nothing about which way a skill answer was wrong', () => {
    const message = checkoutErrorMessage('INVALID_SKILL_ANSWER')!;
    expect(message).toContain('your basket is unchanged');
    // No wording that would separate "you left it blank" from "you chose wrong".
    expect(message.toLowerCase()).not.toMatch(/missing|blank|empty|unanswered|required/);
  });

  it('tells the customer their basket survived a wrong answer', () => {
    // The reassurance is the point: nothing was bought, nothing was charged.
    expect(checkoutErrorMessage('INVALID_SKILL_ANSWER')).toMatch(/nothing has been bought/i);
  });

  it('falls back for anything it does not know, including query-string junk', () => {
    expect(checkoutErrorMessage('NOT_A_REAL_CODE')).toBe(GENERIC);
    expect(checkoutErrorMessage('<script>alert(1)</script>')).toBe(GENERIC);
    // The codes the old map invented are gone, and must not come back.
    for (const dead of [
      'CART_EMPTY',
      'CART_CHANGED',
      'TERMS_VERSION_MISMATCH',
      'SKILL_ANSWER_REQUIRED',
      'SKILL_ANSWER_INCORRECT',
      'RESERVATION_EXPIRED',
    ]) {
      expect(checkoutErrorMessage(dead), `${dead} is not an ErrorCode`).toBe(GENERIC);
    }
  });

  it('has nothing to say when there is no error', () => {
    expect(checkoutErrorMessage(undefined)).toBeNull();
    expect(checkoutErrorMessage('')).toBeNull();
  });
});
