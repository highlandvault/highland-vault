import { FakePaymentProvider, type PaymentProvider } from '@hv/payments';
import type { ApiEnv } from '../config/env';

/** Injection token. The value is a provider, or null when none is configured. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * The provider this deployment pays through, or null.
 *
 * Null is the correct answer in production today: no production provider has
 * been chosen (OPEN O13), and ADR-0006 exists precisely so that decision can
 * be made late. An API with no provider still serves every other route; only
 * starting a payment fails, and it fails closed with a clear refusal rather
 * than pretending to have taken money.
 *
 * Two independent things keep the fake out of production. The environment
 * schema refuses `FAKE_PAYMENT_WEBHOOK_SECRET` there, and the fake provider's
 * own constructor throws if it is built outside development or test. Either
 * alone would do; both means a mistake in one is not enough.
 *
 * Per-market provider selection is P6-7. Until then a deployment has at most
 * one, which is all one fake provider needs.
 */
export function createPaymentProvider(env: ApiEnv): PaymentProvider | null {
  if (env.FAKE_PAYMENT_WEBHOOK_SECRET === undefined) return null;
  return new FakePaymentProvider({
    webhookSecret: env.FAKE_PAYMENT_WEBHOOK_SECRET,
    environment: env.NODE_ENV,
  });
}
