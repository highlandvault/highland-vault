import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, type DbExecutor, sql } from '@hv/db';
import type { PaymentProvider } from '@hv/payments';
import { Errors } from '../common/errors';
import { DATABASE } from '../database/database.module';
import { PAYMENT_PROVIDERS } from './payment-provider.factory';

/** A market's configuration, as the admin surface shows it. Never a secret. */
export interface MarketPaymentConfig {
  readonly marketId: string;
  readonly providerCode: string | null;
  readonly configRef: string | null;
}

/**
 * Which provider a market pays through (Revision 2 B10; P6-7; D17 = A).
 *
 * Until P6-7 a deployment had **one** provider, injected everywhere, and each
 * consumer compared the payment in front of it against that single instance.
 * That was right while one fake provider was all there was, and it stops being
 * right the moment B10's actual rule applies: the provider is a property of the
 * **market**, so the United Kingdom and Ireland may settle through different
 * providers under different agreements.
 *
 * ## Two lookups, and they are deliberately not the same lookup
 *
 * **By market** — what initiation, reconciliation and refunds use. It reads
 * `market_payment_configs`, finds the market's provider code, and returns the
 * built provider for it. A market with no configuration cannot take a payment,
 * which is the correct state for every market today (OPEN O13).
 *
 * **By code** — what webhook intake uses, and it **never reads the database**.
 * That is a security decision, not an optimisation. If webhook resolution
 * consulted `market_payment_configs`, then a delivery for a configured provider
 * and one for an unconfigured provider would answer differently, and anybody
 * could enumerate which markets this deployment has configured by sending
 * unsigned rubbish at the route. Resolving from the environment alone keeps the
 * answer identical for every code this deployment cannot speak, which is
 * exactly what P6-3 established and what its tests assert.
 *
 * ## What is not here
 *
 * `config_ref` names which credential set a provider should use. Nothing reads
 * it yet, because no production provider exists to have credential sets (OPEN
 * O13) and the fake provider takes its secret from the environment like
 * everything else. It is stored, audited and shown to operators now so that the
 * decision it records survives; wiring it to a credential lookup belongs with
 * the provider that needs one. Saying so is better than a lookup that pretends.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: ReadonlyMap<string, PaymentProvider>,
  ) {}

  /**
   * The provider a market pays through, or null when it has none.
   *
   * Null covers three different situations on purpose — no configuration row
   * value, a code this deployment cannot build, and no providers configured at
   * all — because a caller acts identically on all three: it refuses to take
   * money. Distinguishing them here would only invite a caller to care.
   */
  async forMarket(db: DbExecutor, marketId: string): Promise<PaymentProvider | null> {
    const config = await this.configFor(db, marketId);
    if (!config?.providerCode) return null;
    const provider = this.providers.get(config.providerCode);
    if (!provider) {
      // Configured to a provider this deployment cannot build. Fail closed and
      // say so in the log, because it is an operator error and silence would
      // leave a market mysteriously unable to take payments.
      this.logger.error(
        `market ${marketId} is configured for provider "${config.providerCode}", which is not available here`,
      );
      return null;
    }
    return provider;
  }

  /**
   * The provider a market pays through, or a closed refusal.
   *
   * The refusal is the same one the single-provider code raised, with the same
   * code and the same wording, so a customer cannot tell a market with no
   * provider from a deployment with none — and neither reveals anything about
   * another market.
   */
  async requireForMarket(db: DbExecutor, marketId: string): Promise<PaymentProvider> {
    const provider = await this.forMarket(db, marketId);
    if (!provider) {
      throw Errors.badRequest('PAYMENT_PROVIDER_UNAVAILABLE', 'Payments are not available yet.');
    }
    return provider;
  }

  /**
   * The provider with this code, from the environment only.
   *
   * **Never reads `market_payment_configs`** — see the note above. A code this
   * deployment did not build is simply absent, whatever any market is
   * configured for.
   */
  byCode(code: string): PaymentProvider | null {
    return this.providers.get(code) ?? null;
  }

  /** Every provider code this deployment can build. For operators, never for customers. */
  availableCodes(): readonly string[] {
    return [...this.providers.keys()].sort();
  }

  /** A market's stored configuration. */
  async configFor(db: DbExecutor, marketId: string): Promise<MarketPaymentConfig | null> {
    const { rows } = await sql<{
      market_id: string;
      provider_code: string | null;
      config_ref: string | null;
    }>`
      SELECT market_id, provider_code, config_ref
        FROM market_payment_configs WHERE market_id = ${marketId}::uuid
    `.execute(db);
    const row = rows[0];
    if (!row) return null;
    return {
      marketId: row.market_id,
      providerCode: row.provider_code,
      configRef: row.config_ref,
    };
  }
}
