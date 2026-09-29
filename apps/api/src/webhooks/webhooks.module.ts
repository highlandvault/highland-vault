import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentEventsRepository } from './payment-events.repository';
import { WebhookIntakeService } from './webhook-intake.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Provider webhook intake (P6-3).
 *
 * It stores what arrived and acknowledges it. Nothing here moves an order,
 * sells a ticket or writes an outbox event — finalisation is P6-4, and keeping
 * the two apart is a locked decision rather than a convenience.
 *
 * `PaymentsModule` is imported for the provider and the attempt repository, so
 * an event is matched and verified against the same records that created it.
 */
@Module({
  imports: [OrdersModule, PaymentsModule],
  controllers: [WebhooksController],
  providers: [PaymentEventsRepository, WebhookIntakeService],
  exports: [PaymentEventsRepository],
})
export class WebhooksModule {}
