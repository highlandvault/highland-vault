import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { API_ENV, type ApiEnv } from '../config/env';
import { GuestsModule } from '../guests/guests.module';
import { MarketsModule } from '../markets/markets.module';
import { AuditModule } from '../audit/audit.module';
import { OrdersModule } from '../orders/orders.module';
import { TicketsModule } from '../tickets/tickets.module';
import { PAYMENT_PROVIDERS, createPaymentProviders } from './payment-provider.factory';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { AdminPaymentConfigController } from './admin-payment-config.controller';
import { AdminPaymentConfigService } from './admin-payment-config.service';
import { AdminPaymentsController } from './admin-payments.controller';
import { OrderAccessController } from './order-access.controller';
import { AdminPaymentsService } from './admin-payments.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsReconcileService } from './payments-reconcile.service';
import { PaymentsService } from './payments.service';
import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';

/**
 * Payments (P6-2).
 *
 * The provider is built from configuration once, at startup, and may legitimately
 * be null: no production provider has been chosen yet (OPEN O13). Nothing else
 * in the application knows which provider it is — only `@hv/payments`' interface
 * reaches this far, which is what ADR-0006 exists to keep true.
 *
 * `OrdersModule` is imported rather than reimplemented: an attempt is priced
 * from the order, and the order repository is the only thing that reads one.
 */
@Module({
  imports: [AuditModule, AuthModule, GuestsModule, MarketsModule, OrdersModule, TicketsModule],
  controllers: [
    PaymentsController,
    AdminPaymentsController,
    AdminPaymentConfigController,
    OrderAccessController,
  ],
  providers: [
    AdminPaymentsService,
    AdminPaymentConfigService,
    PaymentProviderRegistry,
    PaymentsRepository,
    PaymentsService,
    PaymentFinalizationService,
    PaymentsReconcileService,
    RefundsRepository,
    RefundsService,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createPaymentProviders(env),
    },
  ],
  // The provider itself is exported so webhook intake verifies deliveries with
  // the same instance that created the payments, rather than building a second
  // one from the same configuration.
  exports: [
    PaymentsRepository,
    PaymentsService,
    PaymentFinalizationService,
    PaymentsReconcileService,
    RefundsRepository,
    RefundsService,
    PaymentProviderRegistry,
    PAYMENT_PROVIDERS,
  ],
})
export class PaymentsModule {}
