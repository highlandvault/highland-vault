import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { API_ENV, type ApiEnv } from '../config/env';
import { PaymentsReconcileService } from '../payments/payments-reconcile.service';
import { RefundsService } from '../payments/refunds.service';
import { createInternalListener, type InternalReconcileResult } from './internal-listener';

/**
 * Owns the internal listener's lifecycle inside Nest (K-a).
 *
 * It follows the worker's scheduler services rather than living in `main.ts`,
 * so the socket is not something bolted on beside the application:
 *
 *   * failing to bind throws out of `onApplicationBootstrap`, which fails
 *     `app.init()` and therefore API startup. A deployment that cannot open
 *     this port does not come up half-working;
 *   * `onModuleDestroy` closes it, so `app.close()` leaves no socket behind —
 *     including in tests, which create and destroy many apps;
 *   * it logs through the Nest logger like everything else.
 */
@Injectable()
export class InternalListenerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InternalListenerService.name);
  private server: FastifyInstance | undefined;
  /** The port actually bound. Differs from the configured one only when it was 0. */
  private boundPort: number | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly reconcile: PaymentsReconcileService,
    private readonly refunds: RefundsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = createInternalListener({
      token: this.env.INTERNAL_API_TOKEN,
      reconcile: (paymentId) => this.run(paymentId),
      retryRefunds: () => this.retry(),
      log: {
        warn: (message) => this.logger.warn(message),
        error: (message) => this.logger.error(message),
      },
    });
    // Not caught. A failure here must fail startup.
    const address = await server.listen({
      host: this.env.INTERNAL_API_HOST,
      port: this.env.INTERNAL_API_PORT,
    });
    this.server = server;
    const bound = server.addresses()[0];
    if (bound) this.boundPort = bound.port;
    this.logger.log(`internal listener on ${address}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
  }

  /** The bound port, for tests that let the operating system choose one. */
  port(): number | undefined {
    return this.boundPort;
  }

  /**
   * One pass over the refunds still owed (K-2).
   *
   * Reports how many were attempted, never which or for whom. `send` swallows
   * its own failures, so this cannot fail because a provider is down — it
   * simply leaves those refunds raised, which is what they are.
   */
  private async retry(): Promise<InternalReconcileResult> {
    const { attempted } = await this.refunds.retryUnsettled();
    return { status: 200, body: { result: 'retried', attempted } };
  }

  /**
   * One reconciliation, as an HTTP result.
   *
   * The shapes are kinds and nothing else. A caller is never told a provider
   * reference, an amount, or which order an unknown payment might belong to.
   */
  private async run(paymentId: string): Promise<InternalReconcileResult> {
    const result = await this.reconcile.reconcile(paymentId);
    switch (result.kind) {
      case 'checked':
        return { status: 200, body: { result: 'checked', outcome: result.outcome.kind } };
      case 'unknown_payment':
        return { status: 404, body: { result: 'unknown_payment' } };
      case 'no_provider_reference':
        return { status: 200, body: { result: 'no_provider_reference' } };
      case 'provider_unavailable':
        // Nothing was changed. 503 so the caller treats it as "not now" rather
        // than as an answer, and tries again on its own schedule.
        return { status: 503, body: { result: 'provider_unavailable' } };
    }
  }
}
