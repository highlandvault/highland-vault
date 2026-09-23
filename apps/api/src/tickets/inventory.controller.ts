import { Controller, Get, Inject, Param } from '@nestjs/common';
import { DrawIdParamSchema, type InventoryResponse } from '@hv/contracts';
import type { Database } from '@hv/db';
import { Errors } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DATABASE } from '../database/database.module';
import { DrawsRepository } from '../draws/draws.repository';
import { MarketsRepository } from '../markets/markets.repository';
import { RequirePermission } from '../rbac/access';
import { TicketsRepository } from './tickets.repository';

/**
 * Read-only ticket inventory for staff. There is deliberately no endpoint that
 * changes ticket states by hand: tickets only move through reservations,
 * expiry and (later) payment.
 */
@Controller('admin/markets/:market/draws/:draw/inventory')
export class InventoryController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly markets: MarketsRepository,
    private readonly draws: DrawsRepository,
    private readonly tickets: TicketsRepository,
  ) {}

  @Get()
  @RequirePermission('admin.access', { scope: { param: 'market' } })
  async get(
    @Param(new ZodValidationPipe(DrawIdParamSchema)) params: { market: string; draw: string },
  ): Promise<InventoryResponse> {
    const market = await this.markets.findByCode(this.db, params.market);
    const draw = market ? await this.draws.findById(this.db, market.id, params.draw) : null;
    if (!draw) throw Errors.notFound('Draw');
    return { inventory: await this.tickets.inventory(this.db, draw.id) };
  }
}
