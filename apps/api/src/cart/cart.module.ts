import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DrawsModule } from '../draws/draws.module';
import { MarketsModule } from '../markets/markets.module';
import { TicketsModule } from '../tickets/tickets.module';
import { CartController } from './cart.controller';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';

/**
 * The server-side basket (P5-5; ADR-0026, ADR-0031).
 *
 * It owns no allocation of its own: `TicketsModule` provides the allocator,
 * the repository and the reservation service, so a basket takes tickets
 * through exactly the path the reservation routes already use, under the same
 * caps, locks and expiry. `AuthModule` supplies the shared fail-closed rate
 * limiter and `MarketsModule` the market guard, as the ticket routes do.
 */
@Module({
  imports: [AuthModule, DrawsModule, MarketsModule, TicketsModule],
  controllers: [CartController],
  providers: [CartRepository, CartService],
  exports: [CartRepository, CartService],
})
export class CartModule {}
