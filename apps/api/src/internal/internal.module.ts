import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { InternalListenerService } from './internal-listener.service';

/**
 * The internal listener (P6-5, K-a).
 *
 * No controller, because nothing here is served by the public application. The
 * service owns a second Fastify socket with one route on it, and Nest owns the
 * service — which is how the socket comes up with the API, fails startup if it
 * cannot, and closes when the application does.
 */
@Module({
  imports: [PaymentsModule],
  providers: [InternalListenerService],
  exports: [InternalListenerService],
})
export class InternalModule {}
