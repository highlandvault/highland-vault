import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, type DbExecutor, enqueueOutboxEvent, sql, withTransaction } from '@hv/db';
import { ORDER_PAID_TOPIC, ORDER_UNFULFILLABLE_TOPIC } from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { DATABASE } from '../database/database.module';
import { OrdersRepository } from '../orders/orders.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import { PaymentsRepository } from './payments.repository';

/** What a confirmation turned out to be. Nothing here reaches a customer verbatim. */
export type FinalizationOutcome =
  /** Tickets sold, order paid. The only outcome that moves inventory. */
  | { readonly kind: 'paid'; readonly orderId: string }
  /** The money is real and the tickets are not available. The order says so. */
  | { readonly kind: 'unfulfillable'; readonly orderId: string; readonly reason: string }
  /** Already settled, by an earlier delivery of this event or another. */
  | { readonly kind: 'already_settled'; readonly orderId: string; readonly status: string }
  /** Nothing was done, and why. The event stays visible for reconciliation. */
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

/**
 * Why a confirmation was not acted on. Short codes: they are recorded on the
 * event and counted, not read out to anybody.
 */
export type RefusalReason =
  /**
   * The event does not say the payment succeeded.
   *
   * Finalisation exists for one claim only. A failed or expired provider status
   * is a fact worth recording and is not an instruction to do anything, and the
   * consequences of treating one as a success are the worst in the system.
   */
  | 'not_successful'
  /** The event names an attempt we have no record of. */
  | 'unknown_payment'
  /**
   * The attempt is already finished as failed or timed out, so it cannot be
   * recorded as the successful one. See the note on this in `confirm`.
   */
  | 'attempt_not_live'
  /** The provider named an amount that is not what the order is owed. */
  | 'amount_mismatch'
  /** The provider named a currency that is not the order's. */
  | 'currency_mismatch';

/** What finalisation is asked to act on: a verified, stored provider claim. */
export interface ConfirmationClaim {
  /** The `payment_events` row this came from, so it can be settled with the rest. */
  readonly eventId: string;
  readonly paymentId: string;
  /** What the provider says happened, normalised. Only `succeeded` finalises anything. */
  readonly state: string;
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * Turning a confirmed payment into a sold ticket (Revision 2 B10 step 3;
 * ADR-0006; Phase 6 decisions D4 = C, D9 = A, D10 = B).
 *
 * This is the transaction the phase exists for, and the one place where money
 * becomes inventory. Everything it does, it does in ONE transaction, because
 * the half-states are all unacceptable: an order paid whose tickets are not
 * sold, tickets sold on an order that is not paid, either without the audit
 * entry, a partial sale, or an announcement committed without the change it
 * announces.
 *
 * **Nothing is trusted on the way in.** The event has been verified and stored
 * by P6-3, and that earns it no authority here: the amount and currency are
 * checked against the ORDER again, inside the transaction, under a lock,
 * because a stored claim is still only a claim. A browser returning from a
 * provider is not an input to this at all.
 *
 * The step order is not stylistic. Tickets are sold while the hold is still
 * live and the hold is closed afterwards, because `hv_tickets_guard` refuses a
 * sale from a hold that is not live (D10 = B) — closing first would make the
 * sale fail. And the cap key is read from the reservation, never re-derived
 * from the buyer, because ADR-0021 bridging may have re-keyed it.
 *
 * Locks are taken in the phase's order — **orders, then reservations, then
 * (inside `hv_end_reservation`) the entrant counter and the tickets** — which
 * is the ticket engine's established order with the order added at the front.
 * Taking them in any other order can deadlock against the expiry sweep.
 */
@Injectable()
export class PaymentFinalizationService {
  private readonly logger = new Logger(PaymentFinalizationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly payments: PaymentsRepository,
    private readonly orders: OrdersRepository,
    private readonly tickets: TicketsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Acts on a confirmed payment, exactly once.
   *
   * Idempotent by construction rather than by checking first: the order is
   * locked, and a second call finds it out of `awaiting_payment` and leaves
   * without touching anything. Combined with the unique index that allows one
   * succeeded payment per order, running this any number of times has the
   * effect of running it once.
   */
  async confirm(claim: ConfirmationClaim): Promise<FinalizationOutcome> {
    return withTransaction(this.db, async (trx) => {
      // Before anything else, and deliberately not left to the caller. This
      // method sells tickets and marks money taken; being called with an event
      // that says a payment FAILED would be the worst defect in the system, so
      // it refuses that here rather than trusting whoever called it to have
      // checked.
      if (claim.state !== 'succeeded') {
        return this.refuse(trx, claim, 'not_successful');
      }

      const payment = await this.payments.findById(trx, claim.paymentId);
      if (!payment) return { kind: 'refused', reason: 'unknown_payment' } as const;

      // 1. The aggregate first, and for the rest of the transaction. Everything
      //    below decides from a row nothing else can move meanwhile.
      await this.lockOrder(trx, payment.orderId);
      const order = await this.orders.findById(trx, payment.marketId, payment.orderId);
      if (!order) {
        // Unreachable: a payment's composite foreign key guarantees its order.
        // Treated as ours rather than the provider's, so it retries.
        throw new Error(`payment ${payment.id} has no order`);
      }

      // 2. Already settled — by an earlier delivery of this event, by another
      //    event, or by a concurrent caller that got here first. The idempotent
      //    exit, and the only one that is not a refusal.
      if (order.status !== 'awaiting_payment') {
        await this.settleEvent(trx, claim.eventId, null);
        return { kind: 'already_settled', orderId: order.id, status: order.status } as const;
      }

      // 3. The order is the authority on the money, not the event and not the
      //    provider. Checked again here, under the lock, because P6-3 checked a
      //    claim and this is the moment it would matter.
      if (claim.currency !== order.currency) {
        return this.refuse(trx, claim, 'currency_mismatch');
      }
      if (claim.amountMinor !== order.externalDueMinor) {
        return this.refuse(trx, claim, 'amount_mismatch');
      }

      // The attempt is this order's by construction — the order was looked up
      // through it, and a payment's composite foreign key to
      // orders (id, market_id) is what makes that safe rather than assumed. So
      // what is left to establish is whether it can still become the
      // successful one.
      if (payment.status === 'succeeded') {
        // The attempt succeeded but the order has not moved. Only reachable if
        // a previous run committed the payment and then failed; the order is
        // still `awaiting_payment`, so carry on and finish the job.
        this.logger.warn(`payment ${payment.id} was already succeeded with its order unsettled`);
      } else if (payment.status !== 'pending' && payment.status !== 'processing') {
        // Finished as failed or timed out, so it cannot be recorded as the
        // successful payment (`hv_payments_guard` refuses that, deliberately:
        // a terminal attempt is terminal).
        //
        // The money may well be real. Deciding what to do about a payment taken
        // against an attempt we had already given up on is the late-payment
        // question, and where it goes is OPEN O7 — so nothing is decided here.
        // The event keeps its reason and stays visible for reconciliation
        // (P6-5) and the refund path (P6-6).
        return this.refuse(trx, claim, 'attempt_not_live');
      }

      // 4 and 5. Every line's hold, locked and re-checked, then sold.
      const items = await this.orders.items(trx, order.id);
      const sale = await this.sell(trx, items);

      if (!sale.fulfilled) {
        // 8. The money is real; the tickets are not there. The order says so
        //    and no ticket is touched — no allowance is returned either, so the
        //    cap is unaffected. The refund RECORD is P6-6's; this slice does
        //    not invent one, and does not pretend the money has been returned.
        await this.transitionOrder(trx, order.id, 'paid_unfulfillable');
        await this.succeedPayment(trx, payment.id);
        await this.record(trx, {
          order,
          action: 'order.paid_unfulfillable',
          topic: ORDER_UNFULFILLABLE_TOPIC,
          eventId: claim.eventId,
          reason: sale.reason,
        });
        this.logger.warn(`order ${order.id} was paid but cannot be fulfilled: ${sale.reason}`);
        return { kind: 'unfulfillable', orderId: order.id, reason: sale.reason } as const;
      }

      // 7. The order and the attempt, conditionally. The application says what
      //    it intends and the database guards agree (D4 = C).
      await this.transitionOrder(trx, order.id, 'paid');
      await this.succeedPayment(trx, payment.id);
      await this.record(trx, {
        order,
        action: 'order.paid',
        topic: ORDER_PAID_TOPIC,
        eventId: claim.eventId,
        reason: null,
      });
      return { kind: 'paid', orderId: order.id } as const;
    });
  }

  // ------------------------------------------------------------- internals

  /**
   * Sells every line's tickets, or reports why it could not.
   *
   * The hold is locked and re-checked first. `effectiveReservationStatus` is
   * not enough here and neither is the row's own `status`: expiry is logical,
   * so a hold can be dead while its row still says `active`, and the check has
   * to be against the clock as well. `now()` is the transaction's own
   * timestamp, the same instant `hv_tickets_guard` will use when it refuses
   * this independently.
   */
  private async sell(
    trx: DbExecutor,
    items: readonly { reservationId: string; quantity: number }[],
  ): Promise<{ fulfilled: true } | { fulfilled: false; reason: string }> {
    // A deterministic order, so two finalisations of different orders that
    // share nothing still cannot interleave into a deadlock.
    const lines = [...items].sort((a, b) => a.reservationId.localeCompare(b.reservationId));
    // Read once: every line must be judged against the same instant, and that
    // instant is the one hv_tickets_guard will use when it checks independently.
    const now = await this.transactionNow(trx);

    for (const line of lines) {
      const reservation = await this.tickets.findById(trx, line.reservationId, true);
      if (!reservation) return { fulfilled: false, reason: 'reservation_missing' };
      if (reservation.status !== 'active') return { fulfilled: false, reason: 'reservation_ended' };
      if (reservation.expiresAt.getTime() <= now.getTime()) {
        return { fulfilled: false, reason: 'reservation_expired' };
      }

      // 5. Sold while the hold is still live. The row count is part of the
      //    check: fewer than the line's quantity means something else has
      //    already moved these tickets, and a partial sale must not commit.
      const sold = await this.sellTickets(trx, line.reservationId);
      if (sold !== line.quantity) {
        return { fulfilled: false, reason: 'tickets_unavailable' };
      }

      // 6. And only then closed (D9 = A). This frees nothing, because its
      //    UPDATE looks for `reserved` rows and there are none left, so no cap
      //    allowance is returned and the sold tickets keep counting against the
      //    entrant — which is correct, and is the NB-1 invariant from 0010.
      //
      //    The entrant key it uses comes from the reservation row, which
      //    ADR-0021 bridging may have re-keyed from an address to an account.
      //    Re-deriving it from the buyer would decrement a counter that does
      //    not exist.
      await this.tickets.end(trx, line.reservationId, 'released');
    }
    return { fulfilled: true };
  }

  /** Moves this hold's reserved tickets to sold, and says how many moved. */
  private async sellTickets(trx: DbExecutor, reservationId: string): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      UPDATE tickets SET status = 'sold'
       WHERE reservation_id = ${reservationId}::uuid AND status = 'reserved'
      RETURNING id
    `.execute(trx);
    return rows.length;
  }

  /**
   * The order, locked for the rest of the transaction.
   *
   * The head of the phase's lock order. Held here rather than in a repository
   * because what is being protected is the decision, not a read.
   */
  private async lockOrder(trx: DbExecutor, orderId: string): Promise<void> {
    await sql`SELECT 1 FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`.execute(trx);
  }

  /** The transaction's own clock, so every time comparison sees one instant. */
  private async transactionNow(trx: DbExecutor): Promise<Date> {
    const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    return rows[0]!.now;
  }

  /**
   * Moves the order, conditionally on it still being where we found it.
   *
   * The condition is what makes two concurrent finalisations safe: the second
   * matches no row, and its transaction has already seen the first's status
   * anyway because of the lock. `hv_orders_status_guard` refuses anything the
   * B7 machine does not allow, whatever this asks for (D4 = C).
   */
  private async transitionOrder(
    trx: DbExecutor,
    orderId: string,
    status: 'paid' | 'paid_unfulfillable',
  ): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      UPDATE orders SET status = ${status}
       WHERE id = ${orderId}::uuid AND status = 'awaiting_payment'
      RETURNING id
    `.execute(trx);
    if (rows.length !== 1) {
      // The lock makes this unreachable. If it ever happens, the transaction
      // must not commit half a finalisation.
      throw new Error(`order ${orderId} would not move to ${status}`);
    }
  }

  /**
   * Records the attempt as the successful one.
   *
   * Conditional, so a payment already marked succeeded by an earlier partial
   * run is left alone rather than colliding with the set-once guard. The unique
   * index on succeeded attempts per order is what guarantees there is only ever
   * one, and it does that whatever this code asks for.
   */
  private async succeedPayment(trx: DbExecutor, paymentId: string): Promise<void> {
    await sql`
      UPDATE payments SET status = 'succeeded'
       WHERE id = ${paymentId}::uuid AND status IN ('pending', 'processing')
    `.execute(trx);
  }

  /**
   * The audit entry, the announcement and the event, all in this transaction.
   *
   * The outbox row commits with the change it describes or not at all — that
   * is the entire point of the outbox (ADR-0028, I14) — and delivery afterwards
   * can never block or fail the finalisation itself.
   *
   * The payload carries no address, no ticket numbers and no provider
   * reference: the order row holds what is needed and this is a notification.
   */
  private async record(
    trx: DbExecutor,
    entry: {
      order: { id: string; orderNumber: string; marketId: string };
      action: 'order.paid' | 'order.paid_unfulfillable';
      topic: string;
      eventId: string;
      reason: string | null;
    },
  ): Promise<void> {
    await this.audit.record(trx, {
      // No human did this. A provider said something and the system acted.
      actor: { type: 'system' },
      action: entry.action,
      entityType: 'order',
      entityId: entry.order.id,
      marketId: entry.order.marketId,
      reason: entry.reason,
      before: { status: 'awaiting_payment' },
      after: { status: entry.action === 'order.paid' ? 'paid' : 'paid_unfulfillable' },
    });
    await enqueueOutboxEvent(trx, entry.topic, {
      orderId: entry.order.id,
      orderNumber: entry.order.orderNumber,
      ...(entry.reason === null ? {} : { reason: entry.reason }),
    });
    await this.settleEvent(trx, entry.eventId, null);
  }

  /** Refuses to act, and leaves the reason on the event for reconciliation. */
  private async refuse(
    trx: DbExecutor,
    claim: ConfirmationClaim,
    reason: RefusalReason,
  ): Promise<FinalizationOutcome> {
    this.logger.warn(`refused to finalise event ${claim.eventId}: ${reason}`);
    await this.settleEvent(trx, claim.eventId, reason);
    return { kind: 'refused', reason };
  }

  /**
   * Marks the event as needing nothing further.
   *
   * Conditional on it not already being settled, so a concurrent delivery does
   * not collide with the guard's settle-once rule.
   */
  private async settleEvent(
    trx: DbExecutor,
    eventId: string,
    reason: string | null,
  ): Promise<void> {
    await sql`
      UPDATE payment_events SET processed_at = now(), last_error = ${reason}
       WHERE id = ${eventId}::uuid AND processed_at IS NULL
    `.execute(trx);
  }
}
