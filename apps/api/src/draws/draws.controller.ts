import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { DrawListResponse, DrawResponse } from '@hv/contracts';
import { z } from 'zod';
import { Errors } from '../common/errors';
import { CurrentMarket, type MarketContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { DrawsService } from './draws.service';

const NoQuery = new ZodValidationPipe(z.strictObject({}));
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Customer draw pages. MarketGuard applies the market gate before anything else. */
@Controller('markets/:market/draws')
@Public()
@UseGuards(MarketGuard)
export class DrawsController {
  constructor(private readonly draws: DrawsService) {}

  @Get()
  async list(
    @Query(NoQuery) _query: object,
    @CurrentMarket() market: MarketContext,
  ): Promise<DrawListResponse> {
    return { draws: await this.draws.list(market) };
  }

  @Get(':slug')
  async detail(
    @Query(NoQuery) _query: object,
    @Param('slug') slug: string,
    @CurrentMarket() market: MarketContext,
  ): Promise<DrawResponse> {
    // A malformed slug can never match a draw: same 404 as an unknown one.
    if (!SLUG.test(slug) || slug.length > 80) throw Errors.notFound('Draw');
    return { draw: await this.draws.detail(market, slug) };
  }
}
