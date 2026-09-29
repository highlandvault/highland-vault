import { Inject, Injectable } from '@nestjs/common';
import type { AdminPaymentConfig, UpdatePaymentConfigRequest } from '@hv/contracts';
import { type Database, sql, withTransaction } from '@hv/db';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { MarketsRepository } from '../markets/markets.repository';
import { PaymentProviderRegistry } from './payment-provider.registry';

/**
 * Reading and changing which provider a market pays through (B10; D17 = A).
 *
 * **Nothing here is a secret.** `config_ref` names which credential set the
 * provider should use; the credentials live in the environment (I15). So there
 * is no redaction to get right and no value that becomes dangerous if a
 * response is logged — which is the point of storing a reference rather than a
 * key.
 *
 * The write is a **sensitive operation** (D17 = A): `config.manage`, which 0006
 * grants to `super_admin` alone, plus fresh step-up MFA, plus a reason, plus an
 * audit row in the same transaction as the change. The route enforces the first
 * three; this service writes the fourth, and the two must not drift apart.
 */
@Injectable()
export class AdminPaymentConfigService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly markets: MarketsRepository,
    private readonly providers: PaymentProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  async get(code: string): Promise<AdminPaymentConfig> {
    const market = await this.requireMarket(code);
    const config = await this.providers.configFor(this.db, market.id);
    if (!config) throw Errors.notFound('Payment configuration');
    return this.toAdmin(
      code,
      config.providerCode,
      config.configRef,
      await this.updatedAt(market.id),
    );
  }

  /**
   * Changes a market's provider, audited with the operator's reason.
   *
   * The whole change is one transaction, so a configuration that moved without
   * a record of who moved it is not a state this can produce. `before` and
   * `after` both go into the audit row: the question an operator asks later is
   * never "what is it now" — they can read that — it is "what was it, and who
   * changed it, and why".
   */
  async update(
    code: string,
    input: UpdatePaymentConfigRequest,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminPaymentConfig> {
    // Both or neither. The database says the same thing, so this is the
    // domain-shaped answer rather than a constraint violation surfacing as 500.
    if ((input.providerCode === null) !== (input.configRef === null)) {
      throw Errors.badRequest(
        'PAYMENT_CONFIG_INCOMPLETE',
        'Set both a provider and a configuration reference, or clear both.',
      );
    }

    const market = await this.requireMarket(code);
    return withTransaction(this.db, async (trx) => {
      const before = await this.providers.configFor(trx, market.id);
      if (!before) throw Errors.notFound('Payment configuration');

      const { rows } = await sql<{ updated_at: Date }>`
        UPDATE market_payment_configs
           SET provider_code = ${input.providerCode}, config_ref = ${input.configRef}
         WHERE market_id = ${market.id}::uuid
        RETURNING updated_at
      `.execute(trx);

      await this.audit.record(trx, {
        actor: { type: 'user', userId: auth.userId },
        action: 'market.payment_config.updated',
        entityType: 'market',
        entityId: market.id,
        marketId: market.id,
        reason: input.reason,
        // References and codes only. There is nothing else in this table.
        before: { providerCode: before.providerCode, configRef: before.configRef },
        after: { providerCode: input.providerCode, configRef: input.configRef },
        meta,
      });

      return this.toAdmin(code, input.providerCode, input.configRef, rows[0]!.updated_at);
    });
  }

  // ------------------------------------------------------------- internals

  private async requireMarket(code: string) {
    const market = await this.markets.findByCode(this.db, code);
    if (!market) throw Errors.notFound('Market');
    return market;
  }

  private async updatedAt(marketId: string): Promise<Date> {
    const { rows } = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM market_payment_configs WHERE market_id = ${marketId}::uuid
    `.execute(this.db);
    return rows[0]!.updated_at;
  }

  /**
   * The operator's view.
   *
   * `resolvable` answers the question a stored code cannot: whether this
   * deployment can actually build that provider. A market configured for a
   * provider the environment never set up is a configuration that will fail
   * closed at payment time, and an operator should see that here rather than
   * discover it from a customer's refused payment.
   */
  private toAdmin(
    market: string,
    providerCode: string | null,
    configRef: string | null,
    updatedAt: Date,
  ): AdminPaymentConfig {
    return {
      market: market as AdminPaymentConfig['market'],
      providerCode,
      configRef,
      resolvable: providerCode !== null && this.providers.byCode(providerCode) !== null,
      availableProviders: [...this.providers.availableCodes()],
      updatedAt: updatedAt.toISOString(),
    };
  }
}
