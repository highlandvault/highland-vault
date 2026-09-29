import { FakePaymentProvider, type PaymentProvider } from '@hv/payments';
import type { ApiEnv } from '../config/env';

/**
 * Injection token: every provider this deployment can build, by code.
 *
 * A map rather than a single instance since P6-7. B10 makes the provider a
 * property of the market, so "the provider" is not a thing a deployment has —
 * what it has is a set it is able to speak to, and which one a given market
 * uses is a row in `market_payment_configs`. `PaymentProviderRegistry` is what
 * joins the two.
 */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');

/**
 * The providers this deployment can build, by code. Empty is correct.
 *
 * Empty is the right answer in production today: no production provider has
 * been chosen (OPEN O13), and ADR-0006 exists precisely so that decision can be
 * made late. An API with no providers still serves every other route; only
 * taking money fails, and it fails closed with a clear refusal rather than
 * pretending to have taken any.
 *
 * Two independent things keep the fake out of production, unchanged by P6-7.
 * The environment schema refuses `FAKE_PAYMENT_WEBHOOK_SECRET` there, and the
 * fake provider's own constructor throws if it is built outside development or
 * test. Either alone would do; both means a mistake in one is not enough.
 *
 * **Credentials stay here.** A provider is constructed from environment
 * configuration and nothing else. `market_payment_configs.config_ref` records
 * which credential set a market's provider should use, and it is a reference,
 * never a secret (I15) — the database never holds anything that could build a
 * provider on its own.
 */
export function createPaymentProviders(env: ApiEnv): ReadonlyMap<string, PaymentProvider> {
  const providers = new Map<string, PaymentProvider>();
  if (env.FAKE_PAYMENT_WEBHOOK_SECRET !== undefined) {
    const fake = new FakePaymentProvider({
      webhookSecret: env.FAKE_PAYMENT_WEBHOOK_SECRET,
      environment: env.NODE_ENV,
    });
    providers.set(fake.code, fake);
  }
  return providers;
}
