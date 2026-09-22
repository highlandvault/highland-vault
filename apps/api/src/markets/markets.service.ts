import { Inject, Injectable } from '@nestjs/common';
import type { Market } from '@hv/contracts';
import type { Database } from '@hv/db';
import { isMarketAvailable } from '@hv/domain';
import { Errors } from '../common/errors';
import type { MarketContext } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { type MarketRecord, MarketsRepository } from './markets.repository';

/** Customer-facing market resolution: the market gate, layers 2 and 3 (ADR-0005). */
@Injectable()
export class MarketsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly repository: MarketsRepository,
  ) {}

  /** Markets available to customers: allowed by ENABLED_MARKETS AND enabled in the database. */
  async listAvailable(): Promise<Market[]> {
    const markets = await this.repository.list(this.db);
    return markets.filter((m) => isMarketAvailable(m, this.env.ENABLED_MARKETS)).map(toPublic);
  }

  /**
   * Resolves a market-scoped request. Unknown, environment-excluded and disabled
   * markets all get the same 404, so the response does not reveal which layer refused.
   */
  async resolveAvailable(code: string): Promise<MarketContext> {
    if (!/^[a-z]{2}$/.test(code)) throw Errors.marketNotAvailable();
    const market = await this.repository.findByCode(this.db, code);
    if (!market || !isMarketAvailable(market, this.env.ENABLED_MARKETS)) {
      throw Errors.marketNotAvailable();
    }
    return {
      id: market.id,
      code: market.code,
      name: market.name,
      currency: market.currency,
      locale: market.locale,
    };
  }
}

export function toPublic(market: MarketRecord | MarketContext): Market {
  return { code: market.code, name: market.name, currency: market.currency, locale: market.locale };
}
