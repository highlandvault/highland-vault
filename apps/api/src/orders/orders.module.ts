import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { DrawsModule } from '../draws/draws.module';
import { MarketsModule } from '../markets/markets.module';
import { TermsModule } from '../terms/terms.module';
import { TicketsModule } from '../tickets/tickets.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { OrdersRepository } from './orders.repository';

/**
 * Checkout and orders (P5-7).
 *
 * It owns no allocation, no basket and no terms rules of its own: the ticket
 * engine, the cart and the terms service are imported so that an order is
 * assembled from the same code that created the holds and recorded the
 * agreement, under the same locks.
 */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    CartModule,
    DrawsModule,
    MarketsModule,
    TermsModule,
    TicketsModule,
  ],
  controllers: [CheckoutController],
  providers: [OrdersRepository, CheckoutService],
  exports: [OrdersRepository, CheckoutService],
})
export class OrdersModule {}
