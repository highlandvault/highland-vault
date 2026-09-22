import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { MarketListResponse, MarketResponse } from '@hv/contracts';
import { z } from 'zod';
import { CurrentMarket, type MarketContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from '../rbac/access';
import { MarketGuard } from './market.guard';
import { MarketsService, toPublic } from './markets.service';

/**
 * No query parameters are accepted: the market context comes from the route
 * only, so `?market=ie` cannot redirect a /markets/uk request.
 */
const NoQuery = new ZodValidationPipe(z.strictObject({}));

@Controller('markets')
@Public()
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get()
  async list(@Query(NoQuery) _query: object): Promise<MarketListResponse> {
    return { markets: await this.markets.listAvailable() };
  }

  @Get(':market')
  @UseGuards(MarketGuard)
  get(@Query(NoQuery) _query: object, @CurrentMarket() market: MarketContext): MarketResponse {
    return { market: toPublic(market) };
  }
}
