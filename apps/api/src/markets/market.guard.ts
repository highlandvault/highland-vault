import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MarketsService } from './markets.service';

/**
 * Market gate, API layer (ADR-0005). Apply to every market-scoped route
 * (`/markets/:market/...`). It resolves the market from the route parameter —
 * the only source of market context — and rejects unavailable markets with
 * 404, whatever the frontend shows.
 */
@Injectable()
export class MarketGuard implements CanActivate {
  constructor(private readonly markets: MarketsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const code = (request.params as Record<string, string | undefined>).market ?? '';
    request.hvMarket = await this.markets.resolveAvailable(code);
    return true;
  }
}
