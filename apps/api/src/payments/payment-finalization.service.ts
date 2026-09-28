import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, type DbExecutor, enqueueOutboxEvent, sql, withTransaction } from '@hv/db';
import { ORDER_PAID_TOPIC, ORDER_UNFULFILLABLE_TOPIC } from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { DATABASE } from '../database/database.module';
import { OrdersRepository } from '../orders/orders.repository';
import { TicketsRepository } from '../tickets/tickets.repository';
import { PaymentsRepository } from './payments.repository';
import { RefundsRepository, refundKeys } from './refunds.repository';
import { RefundsService } from './refunds.service';

/** What a confirmation turned out to be. Nothing here reaches a customer verbatim. */
export type FinalizationOutcome =
  /** Tickets sold, order paid. The only outcome that moves inventory. */
  | { readonly kind: 'paid'; readonly orderId: string }
  /** The money is real and the tickets are not available. The order says so. */
  /**
   * Paid, and nothing can be delivered (D21, D23).
   *
   * A refund is always raised with it, in the same transaction. `refundId` is
   * null only when this order already had one — which is what a repeated
   * delivery looks like.
   */
  | {
      readonly kind: 'unfulfillable';
      readonly orderId: string;
      readonly reason: string;
      readonly refundId: string | null;
    }
  /** Already settled by the very attempt this event names: an ordinary duplicate. */
  | { readonly kind: 'already_settled'; readonly orderId: string; readonly status: string }
  /**
   * The order was settled by a DIFFERENT attempt, so the provider appears to
   * have captured money twice (D22.1).
   *
   * Detected and recorded only. What happens to the money is D22.3 and how it
   * is accounted for is D22.2 — both owner decisions, neither taken here.
   */
  | {
      readonly kind: 'second_capture';
      readonly orderId: string;
      readonly capturedPaymentId: string;
      readonly settledByPaymentId: string;
    }
  /**
   * The order is settled but no payment of it ever succeeded — cancelled, or
   * expired before the provider spoke. The capture matches no settlement.
   */
  | {
      readonly kind: 'capture_without_settlement';
      readonly orderId: string;
      readonly status: string;
    }
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
    private readonly refunds: RefundsRepository,
    private readonly refundsService: RefundsService,
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
    const outcome = await withTransaction(this.db, async (trx) => {
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

      // 2. The order has already been settled. That is not, on its own, enough
      //    to conclude that there is nothing to see here (D22.1).
      //
      //    An ordinary duplicate webhook and a SECOND CAPTURE arrive in exactly
      //    the same shape: a verified success for an order that is already
      //    paid. Returning on the order's status alone made them
      //    indistinguishable, and the second one — money taken twice — left no
      //    trace anywhere in `payments`. So the attempt the event names is
      //    examined before anything is concluded.
      if (order.status !== 'awaiting_payment') {
        return this.classifySettled(trx, claim, order, payment);
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

      // 4. CAN this order still be fulfilled? Asked before anything about the
      //    attempt, and that order matters.
      //
      //    Whether the tickets are still ours is a fact about the world.
      //    Whether our own attempt row is still live is a fact about our
      //    bookkeeping. Asking the bookkeeping question first meant a capture
      //    that genuinely could not be fulfilled — the case B10 already
      //    decides — was reported as a bookkeeping problem instead, and never
      //    reached the `paid_unfulfillable` path that exists for it.
      const items = await this.orders.items(trx, order.id);
      const holds = await this.assessHolds(trx, items);

      if (!holds.fulfillable) {
        // 8. The money is real; the tickets are not there. There is nothing to
        //    release — they have already gone — so the order records the truth
        //    and a refund is raised for the full amount.
        //
        //    Reached whatever state the attempt is in. `succeedPayment` is
        //    conditional, so an attempt already given up on stays terminal and
        //    the ORDER still carries the outcome, which is what the customer
        //    and the refund both need.
        return this.settleUnfulfillable(trx, {
          claim,
          order,
          payment,
          reason: holds.reason,
          release: [],
          from: 'awaiting_payment',
        });
      }

      // 5. The tickets ARE available. Now the attempt has to be able to carry
      //    the money, and this is the only remaining reason it might not be.
      //
      //    The attempt is this order's by construction — the order was looked
      //    up through it, and a payment's composite foreign key to
      //    orders (id, market_id) is what makes that safe rather than assumed.
      if (payment.status === 'succeeded') {
        // The attempt succeeded but the order has not moved. Only reachable if
        // a previous run committed the payment and then failed; the order is
        // still `awaiting_payment`, so carry on and finish the job.
        this.logger.warn(`payment ${payment.id} was already succeeded with its order unsettled`);
      } else if (payment.status !== 'pending' && payment.status !== 'processing') {
        // D21. Finished as failed or timed out, so it cannot be recorded as the
        // successful payment — `hv_payments_guard` refuses that, and the owner
        // decided it stays refused: a terminal attempt is terminal and is NOT
        // resurrected.
        //
        // The tickets are still here, but they are not going to this customer,
        // because the payment that would have bought them is one we had already
        // given up on. So the holds are RELEASED — the tickets go back to the
        // pool and the cap allowance with them — the order records that it was
        // paid and cannot be fulfilled, and the money is refunded in full to
        // the instrument it came from.
        return this.settleUnfulfillable(trx, {
          claim,
          order,
          payment,
          reason: 'attempt_not_live',
          release: items,
          from: 'awaiting_payment',
        });
      }

      // 6. Sell, then close each hold.
      const sale = await this.sellAll(trx, items);
      if (!sale.sold) {
        // The holds were live a moment ago and their tickets are not sellable
        // now. Nothing partial may commit, so this transaction does not.
        throw new Error(`order ${order.id} could not be sold: ${sale.reason}`);
      }

      // 7. The order and the attempt, conditionally. The application says what
      //    it intends and the database guards agree (D4 = C).
      await this.transitionOrder(trx, order.id, 'paid', 'awaiting_payment');
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

    // Committed. Now ask the provider for the money back, outside the
    // transaction and holding no locks (D21, D23).
    //
    // Best-effort by design: the decision is already durable, and a provider
    // being unreachable must not undo it. `refundId` is null when this order
    // already had a refund, which is what a repeated delivery looks like — so
    // a webhook sent ten times asks the provider once.
    if (outcome.kind === 'unfulfillable' && outcome.refundId !== null) {
      await this.refundsService.send(outcome.refundId);
    }
    return outcome;
  }

  // ------------------------------------------------------------- internals

  /**
   * The one place an order becomes paid-and-undeliverable (D21, D23).
   *
   * Three things are true of every route into it: the money is real, nothing
   * can be delivered, and the customer gets it back. So all three happen here,
   * in one transaction — the order moves, any holds still standing are
   * released, and the refund is raised — because an order in
   * `paid_unfulfillable` with no refund behind it would be the worst record
   * this system could keep.
   *
   * `release` is the lines whose holds are still live. It is empty when they
   * have already gone, and populated for D21, where the tickets are still
   * sitting reserved and are not going to this customer. Releasing returns the
   * cap allowance with them, which is correct: nothing was bought.
   *
   * The attempt is never resurrected. `succeedPayment` is conditional, so a
   * terminal attempt stays terminal (D21, D23) and a live one records that it
   * took the money.
   */
  private async settleUnfulfillable(
    trx: DbExecutor,
    input: {
      claim: ConfirmationClaim;
      order: { id: string; orderNumber: string; marketId: string };
      payment: { id: string; provider: string };
      reason: string;
      release: readonly { reservationId: string }[];
      /** The status the order is in now. `expired` is D23's route in. */
      from: 'awaiting_payment' | 'expired';
    },
  ): Promise<FinalizationOutcome> {
    const { claim, order, payment, reason } = input;

    await this.transitionOrder(trx, order.id, 'paid_unfulfillable', input.from);
    await this.succeedPayment(trx, payment.id);

    for (const line of input.release) {
      // Released, not expired: the hold is being given up deliberately rather
      // than having run out. `hv_end_reservation` frees the reserved tickets and
      // returns the allowance for exactly those it freed (the 0010 NB-1 fix),
      // using the entrant key stored on the reservation — which ADR-0021
      // bridging may have re-keyed, and which must never be re-derived.
      await this.tickets.end(trx, line.reservationId, 'released');
    }

    const refund = await this.refunds.raiseIfNew(trx, {
      orderId: order.id,
      marketId: order.marketId,
      paymentId: payment.id,
      provider: payment.provider,
      reason: 'unfulfillable',
      // Derived from the ORDER: an order can be unfulfillable once, so ten
      // deliveries of this event raise one refund.
      idempotencyKey: refundKeys.unfulfillable(order.id),
    });

    await this.record(trx, {
      order,
      action: 'order.paid_unfulfillable',
      topic: ORDER_UNFULFILLABLE_TOPIC,
      eventId: claim.eventId,
      reason,
    });
    this.logger.warn(`order ${order.id} was paid but cannot be fulfilled: ${reason}`);
    return {
      kind: 'unfulfillable',
      orderId: order.id,
      reason,
      refundId: refund?.id ?? null,
    } as const;
  }

  /**
   * Works out what a success for an already-settled order actually is (D22.1).
   *
   * Three things arrive looking identical, and only the first is harmless:
   *
   *   A. the same attempt that settled this order, delivered again — an
   *      ordinary duplicate webhook, and the idempotent exit;
   *   B. a DIFFERENT attempt of the same order — the provider has captured
   *      money twice, and until now that was silently absorbed as A;
   *   C. an order settled by no successful payment at all — cancelled, or
   *      expired before this arrived — so the capture matches no settlement.
   *
   * **This detects and records. It resolves nothing.** What happens to money
   * captured twice is D22.3, and whether a second capture gets an accounting
   * record of its own is D22.2; both are owner decisions and neither is taken
   * here. No payment row is created, no status moves, no ticket is touched.
   *
   * B and C are left UNPROCESSED on purpose. `processed_at` means "nothing is
   * owed on this event", and something is very much owed on both — so the
   * reconciler's own index finds them, rather than their only trace being a
   * string somebody has to think to look for.
   */
  private async classifySettled(
    trx: DbExecutor,
    claim: ConfirmationClaim,
    order: { id: string; orderNumber: string; marketId: string; status: string },
    payment: { id: string; provider: string },
  ): Promise<FinalizationOutcome> {
    const settlingPayment = await this.payments.findSucceededForOrder(trx, order.id);

    // A. The attempt that settled it, said again.
    if (settlingPayment && settlingPayment.id === payment.id) {
      await this.settleEvent(trx, claim.eventId, null);
      return { kind: 'already_settled', orderId: order.id, status: order.status } as const;
    }

    // B. A different attempt, and the order is already paid for. Two captures.
    if (settlingPayment) {
      this.logger.error(
        `possible second capture on order ${order.id}: event ${claim.eventId} names payment ` +
          `${payment.id}, but the order was settled by ${settlingPayment.id}`,
      );
      await this.flagEvent(trx, claim.eventId, 'second_capture');
      return {
        kind: 'second_capture',
        orderId: order.id,
        capturedPaymentId: payment.id,
        settledByPaymentId: settlingPayment.id,
      } as const;
    }

    // C. Settled, but by nothing that succeeded — so this capture matches no
    //    settlement at all.
    //
    //    D23 decides one of these: the order's deadline passed before the
    //    provider spoke. The money is real and the holds are long gone, so the
    //    order stops standing as a record of a customer who never paid and
    //    records what actually happened, with a refund behind it. `expired ->
    //    paid_unfulfillable` is permitted for exactly this, and only this
    //    (migration 0024).
    if (order.status === 'expired') {
      return this.settleUnfulfillable(trx, {
        claim,
        order,
        payment,
        reason: 'order_expired',
        // Nothing to release: the holds went when the order did.
        release: [],
        from: 'expired',
      });
    }

    // Anything else — a cancelled order, most likely — is not a case anyone has
    // decided. It is recorded and left for a person, because guessing at what
    // to do with money against an order somebody cancelled would be inventing
    // policy rather than applying it.
    this.logger.error(
      `capture with no settlement on order ${order.id} (${order.status}): event ${claim.eventId}`,
    );
    await this.flagEvent(trx, claim.eventId, 'capture_without_settlement');
    return {
      kind: 'capture_without_settlement',
      orderId: order.id,
      status: order.status,
    } as const;
  }

  /**
   * Locks every hold behind the order and says whether it can still be fulfilled.
   *
   * Separate from selling, and asked first, so that "can these tickets still be
   * delivered" is answered before anything about our own payment records. A
   * capture that cannot be fulfilled has a defined outcome (B10,
   * `paid_unfulfillable`) whatever state the attempt is in, and mixing the two
   * questions is what previously sent that case down the wrong path.
   *
   * The row's own `status` is not enough. Expiry is logical, so a hold can be
   * dead while its row still says `active`, and the check has to be against the
   * clock as well. `now()` is the transaction's timestamp — the same instant
   * `hv_tickets_guard` will use when it refuses the sale independently.
   */
  private async assessHolds(
    trx: DbExecutor,
    items: readonly { reservationId: string; quantity: number }[],
  ): Promise<{ fulfillable: true } | { fulfillable: false; reason: string }> {
    // A deterministic order, so two finalisations that share nothing still
    // cannot interleave into a deadlock.
    const lines = [...items].sort((a, b) => a.reservationId.localeCompare(b.reservationId));
    // Read once: every line is judged against the same instant.
    const now = await this.transactionNow(trx);

    for (const line of lines) {
      // Locked here and held for the rest of the transaction, so a hold cannot
      // lapse between being assessed and being sold.
      const reservation = await this.tickets.findById(trx, line.reservationId, true);
      if (!reservation) return { fulfillable: false, reason: 'reservation_missing' };
      if (reservation.status !== 'active') {
        return { fulfillable: false, reason: 'reservation_ended' };
      }
      if (reservation.expiresAt.getTime() <= now.getTime()) {
        return { fulfillable: false, reason: 'reservation_expired' };
      }
    }
    return { fulfillable: true };
  }

  /**
   * Sells each line's tickets and then closes its hold.
   *
   * Called only once `assessHolds` has locked every hold and found it live, so
   * this is the sale itself and not another round of checking. The row count is
   * still part of it: fewer tickets than the line's quantity means something
   * else moved them, and a partial sale must never commit.
   */
  private async sellAll(
    trx: DbExecutor,
    items: readonly { reservationId: string; quantity: number }[],
  ): Promise<{ sold: true } | { sold: false; reason: string }> {
    const lines = [...items].sort((a, b) => a.reservationId.localeCompare(b.reservationId));

    for (const line of lines) {
      // Sold while the hold is still live — `hv_tickets_guard` requires that
      // independently (D10 = B), which is why the close below comes after.
      const sold = await this.sellTickets(trx, line.reservationId);
      if (sold !== line.quantity) return { sold: false, reason: 'tickets_unavailable' };

      // And only then closed (D9 = A). This frees nothing, because its UPDATE
      // looks for `reserved` rows and there are none left, so no cap allowance
      // is returned and the sold tickets keep counting against the entrant —
      // which is correct, and is the NB-1 invariant from 0010.
      //
      // The entrant key it uses comes from the reservation row, which ADR-0021
      // bridging may have re-keyed from an address to an account. Re-deriving it
      // from the buyer would decrement a counter that does not exist.
      await this.tickets.end(trx, line.reservationId, 'released');
    }
    return { sold: true };
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
    // The status this transition expects to find. Passed in rather than assumed:
    // D23 moves an order out of `expired`, and an earlier version hardcoded
    // `awaiting_payment` here — which made that transition match no row and
    // roll the whole finalisation back.
    from: 'awaiting_payment' | 'expired',
  ): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      UPDATE orders SET status = ${status}
       WHERE id = ${orderId}::uuid AND status = ${from}
      RETURNING id
    `.execute(trx);
    if (rows.length !== 1) {
      // The lock makes this unreachable. If it ever happens, the transaction
      // must not commit half a finalisation.
      throw new Error(`order ${orderId} would not move from ${from} to ${status}`);
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
   * Records why an event needs attention, and deliberately leaves it UNSETTLED.
   *
   * The counterpart to `settleEvent`. `processed_at` means "nothing is owed on
   * this", and for a second capture or a capture with no settlement a great deal
   * is owed — so it stays NULL and the reconciler's own
   * `payment_events_unprocessed_idx` finds it. A reason nobody thinks to query
   * for is not a record.
   *
   * `hv_payment_events_guard` lets `last_error` move freely and never lets the
   * event itself change, so this needs no schema of its own.
   */
  private async flagEvent(trx: DbExecutor, eventId: string, reason: string): Promise<void> {
    await sql`
      UPDATE payment_events SET last_error = ${reason}
       WHERE id = ${eventId}::uuid AND processed_at IS NULL
    `.execute(trx);
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
