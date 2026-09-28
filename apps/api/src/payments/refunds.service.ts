import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type Database, sql, withTransaction } from '@hv/db';
import { PaymentProviderError, type PaymentProvider } from '@hv/payments';
import { AuditService } from '../audit/audit.service';
import { DATABASE } from '../database/database.module';
import { PAYMENT_PROVIDER } from './payment-provider.factory';
import { PaymentsRepository } from './payments.repository';
import { RefundsRepository, refundKeys } from './refunds.repository';

/** What asking for a duplicate capture to be refunded turned out to be. */
export type DuplicateRefundOutcome =
  | { readonly kind: 'raised'; readonly refundId: string }
  | { readonly kind: 'already_raised'; readonly refundId: string }
  /** The event is not a confirmed duplicate capture, so there is nothing to refund. */
  | { readonly kind: 'not_a_duplicate_capture' };

/**
 * Refunds (D15a, D15b, D21, D22.3, D23).
 *
 * Two jobs, deliberately separate.
 *
 * **Raising** a refund is a decision, and it belongs in the transaction that
 * caused it — which is why finalisation raises its own directly through the
 * repository rather than calling this service. A refund row that could be
 * written without the state change that justified it would be worse than none.
 *
 * **Sending** it to the provider is a network call, so it happens afterwards,
 * outside any transaction and holding no locks. That is safe because the row is
 * already there: `refunds.idempotency_key` is UNIQUE and the provider's own
 * `refund()` is idempotent on the same key (B10), so however many times this is
 * attempted the customer is refunded once.
 *
 * Phase 6 raises refunds and asks the provider to make them. Completion,
 * reporting and the admin surface are P10's, and the wider refund policy is
 * OPEN O7.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    private readonly refunds: RefundsRepository,
    private readonly payments: PaymentsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Refunds a confirmed duplicate capture (D22.3).
   *
   * Invoked, not automatic. Detection (D22.1) happens at webhook time and flags
   * the event; deciding that the flagged capture is real is a reconciliation
   * step, so nothing here runs off the back of a provider message. P6-5 will
   * call this; until then it is called by an operator path or by a test.
   *
   * The order stays `paid`. This money is not a second payment for it and is
   * never reinterpreted as one — the order was already settled by another
   * attempt, and that remains the single succeeded payment.
   */
  async refundDuplicateCapture(paymentEventId: string): Promise<DuplicateRefundOutcome> {
    const outcome = await withTransaction(this.db, async (trx) => {
      const event = await this.loadFlaggedCapture(trx, paymentEventId);
      if (!event) return { kind: 'not_a_duplicate_capture' } as const;

      const payment = await this.payments.findById(trx, event.paymentId);
      if (!payment) return { kind: 'not_a_duplicate_capture' } as const;

      const key = refundKeys.duplicateCapture(paymentEventId);
      const raised = await this.refunds.raiseIfNew(trx, {
        orderId: payment.orderId,
        marketId: payment.marketId,
        paymentId: payment.id,
        provider: payment.provider,
        reason: 'duplicate_capture',
        // Derived from the EVENT, not the order: an order may legitimately
        // suffer two separate duplicate captures, and each needs its own
        // refund, while ten deliveries of one need a single refund.
        idempotencyKey: key,
      });

      if (!raised) {
        const existing = await this.refunds.findByIdempotencyKey(trx, key);
        // Already dealt with. Nothing is raised twice and nothing is audited
        // twice.
        return { kind: 'already_raised', refundId: existing!.id } as const;
      }

      await this.audit.record(trx, {
        // No human decided this; a reconciliation step did.
        actor: { type: 'system' },
        action: 'payment.duplicate_capture_refunded',
        entityType: 'order',
        entityId: payment.orderId,
        marketId: payment.marketId,
        reason: 'duplicate_capture',
        after: { refundId: raised.id, amountMinor: raised.amountMinor },
      });

      // Settled now: the exception has been dealt with, so it stops appearing
      // as work outstanding.
      await sql`
        UPDATE payment_events SET processed_at = now()
         WHERE id = ${paymentEventId}::uuid AND processed_at IS NULL
      `.execute(trx);

      return { kind: 'raised', refundId: raised.id } as const;
    });

    // Outside the transaction, and only for a refund this call raised.
    if (outcome.kind === 'raised') await this.send(outcome.refundId);
    return outcome;
  }

  /**
   * Asks the provider to make a raised refund.
   *
   * Best-effort and never thrown from. The decision is already committed, so a
   * provider being unreachable must not undo it; the row stays `raised`, which
   * is exactly what `refunds_unsettled_idx` is for.
   *
   * Idempotent twice over: one row can exist per decision, and the provider is
   * idempotent on that row's key.
   */
  async send(refundId: string): Promise<void> {
    if (!this.provider) {
      this.logger.warn(`refund ${refundId} raised with no provider configured`);
      return;
    }
    const refund = await this.refunds.findById(this.db, refundId);
    if (!refund || refund.status !== 'raised') return;
    if (!refund.paymentId) {
      this.logger.error(`refund ${refund.id} has no payment to return money to`);
      return;
    }
    const payment = await this.payments.findById(this.db, refund.paymentId);
    if (!payment?.providerReference) {
      // Nothing to address the refund to: the provider never gave this attempt
      // a reference. Left raised for a person.
      this.logger.error(`refund ${refund.id} has no provider reference to refund against`);
      return;
    }

    try {
      const result = await this.provider.refund({
        providerReference: payment.providerReference,
        amount: { amountMinor: refund.amountMinor, currency: refund.currency },
        idempotencyKey: refund.idempotencyKey,
        reason: refund.reason,
      });
      await this.refunds.settle(this.db, refund.id, {
        status: result.state === 'failed' ? 'failed' : 'succeeded',
        providerRefundReference: result.providerRefundReference,
      });
    } catch (error) {
      const kind = error instanceof PaymentProviderError ? error.kind : 'unknown';
      // Left `raised`, deliberately. A refund we could not make is not a refund
      // that failed — it is one still owed.
      this.logger.error(`refund ${refund.id} could not be sent: ${kind}`);
    }
  }

  /** The event, if it is a capture this system flagged as a duplicate. */
  private async loadFlaggedCapture(
    trx: Parameters<RefundsRepository['raiseIfNew']>[0],
    paymentEventId: string,
  ): Promise<{ paymentId: string } | null> {
    const { rows } = await sql<{ payment_id: string | null; last_error: string | null }>`
      SELECT payment_id, last_error FROM payment_events WHERE id = ${paymentEventId}::uuid FOR UPDATE
    `.execute(trx);
    const event = rows[0];
    // Only a capture this system itself classified as a duplicate. Anything
    // else is not this method's to act on, which keeps an ordinary duplicate
    // webhook and a genuine second capture from ever being confused here.
    if (!event || event.last_error !== 'second_capture' || !event.payment_id) return null;
    return { paymentId: event.payment_id };
  }
}
