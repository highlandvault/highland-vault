import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Payment } from '@hv/contracts';
import { type Database, type DbExecutor, sql, withTransaction } from '@hv/db';
import { PaymentProviderError, type PaymentProvider } from '@hv/payments';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { ownerKey, type CheckoutIdentity } from '../cart/checkout-identity';
import { API_ENV, type ApiEnv } from '../config/env';
import { Errors } from '../common/errors';
import type { MarketContext } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { GuestSessionsService } from '../guests/guest-sessions.service';
import { type OrderBuyer, OrdersRepository } from '../orders/orders.repository';
import { PAYMENT_PROVIDER } from './payment-provider.factory';
import { type PaymentRecord, PaymentsRepository } from './payments.repository';

/**
 * Starting a payment (Revision 2 B10; ADR-0006; Phase 6 decisions D1, D1a,
 * D1b, D3, D3a, D3b).
 *
 * **This service takes no money and confirms nothing.** It records an attempt
 * and hands the customer a place to pay. Whether they paid is decided later,
 * by a verified webhook (P6-3, P6-4) or a trusted provider status check
 * (P6-5), and a browser returning from the provider is neither of those.
 *
 * Two facts are true of every order here, and neither is left to this code to
 * get right: at most one attempt may be live, and at most one may ever
 * succeed. Both are partial unique indexes in `0020`, so a bug in this file
 * cannot produce a second live session or a second successful payment.
 *
 * The amount is likewise not this service's to choose. It is selected from the
 * order inside the INSERT, and a composite foreign key ties it to
 * `orders.external_due_minor`, so no request and no provider response can
 * change what is owed (I4, I5).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    private readonly payments: PaymentsRepository,
    private readonly orders: OrdersRepository,
    private readonly guests: GuestSessionsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Starts a payment for the order, or hands back the one already in progress.
   *
   * Three things can be returned, and they are all the same shape to the
   * caller: the attempt this idempotency key already created, the attempt
   * that is already live for this order (D3b = A), or a new one.
   *
   * The provider is called OUTSIDE the transaction, deliberately. The insert
   * is what claims the order's single live slot, so it must commit before any
   * network call; holding a row lock open across a third party's HTTP request
   * is how a slow provider becomes a database problem.
   */
  async initiate(
    market: MarketContext,
    identity: CheckoutIdentity,
    orderId: string,
    idempotencyKey: string,
  ): Promise<Payment> {
    const buyer = this.buyerOf(identity);
    // Fail-closed before anything is read or written: a Redis outage refuses
    // the payment rather than running it unlimited (B19).
    await this.rateLimiter.consume(RATE_LIMITS.paymentsPerOwner, ownerKey(identity));
    const provider = this.requireProvider();

    // A key already used is answered before any work, as checkout does it.
    const replay = await this.payments.findByIdempotencyKey(this.db, idempotencyKey);
    if (replay) {
      // This key already paid for something else — whether that was this
      // customer's other order or a stranger's. A mistake rather than a retry,
      // and answered the same way checkout answers it, before ownership is
      // considered: refusing here with a 404 about the caller's OWN order
      // would be a lie about an order they can see.
      if (replay.orderId !== orderId) {
        throw Errors.conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'That idempotency key has already been used for a different payment.',
        );
      }
      // Same key, same order — a genuine retry. Ownership still decides, and a
      // stranger who guessed both gets the same 404 as for any order of
      // somebody else's.
      const order = await this.requireOwnedOrder(this.db, market, buyer, orderId);
      const started = await this.startWithProvider(provider, replay, order);
      return this.toDto(started.attempt, order.expiresAt, started.redirectUrl);
    }

    const { attempt, order } = await withTransaction(this.db, async (trx) => {
      const order = await this.requireOwnedOrder(trx, market, buyer, orderId, true);
      this.assertPayable(order);

      // Locked, so two "Pay" clicks decide about the same attempt in turn
      // rather than racing to insert against the one-live index.
      const live = await this.payments.findLiveForUpdate(trx, orderId);
      if (live) {
        if (live.expiresAt.getTime() > Date.now()) {
          // D3b = A: the customer is sent back to the payment they already
          // have, not given a second one and not refused.
          return { attempt: live, order };
        }
        // Lapsed (D3a). Finishing it here is not housekeeping: the
        // one-live-attempt index counts it until it is terminal, so without
        // this the customer could never try again.
        await this.payments.finish(trx, live.id, 'expired', {
          code: 'ATTEMPT_TIMED_OUT',
          message: 'The payment was not completed in time.',
        });
      }

      const created = await this.payments.insertIfNew(trx, {
        orderId,
        marketId: market.id,
        provider: provider.code,
        idempotencyKey,
        ttlSeconds: this.env.PAYMENT_ATTEMPT_TTL_SECONDS,
      });
      if (!created) {
        // Another request claimed the key while this transaction ran.
        throw Errors.conflict('CONFLICT', 'That payment could not be started.');
      }
      return { attempt: created, order };
    });

    const started = await this.startWithProvider(provider, attempt, order);
    return this.toDto(started.attempt, order.expiresAt, started.redirectUrl);
  }

  // ------------------------------------------------------------- internals

  /**
   * Where to send the customer for this attempt.
   *
   * Asked of the provider every time, including for an attempt that already
   * exists, and this is what makes D3b work without storing a redirect URL.
   * `createPayment` is idempotent on its key (B10 REQ), so calling it again
   * for a live attempt returns that same session rather than opening another.
   *
   * The amount comes from the ORDER, never from the attempt row's own copy and
   * never from anything a client sent.
   */
  private async startWithProvider(
    provider: PaymentProvider,
    attempt: PaymentRecord,
    order: { orderNumber: string; externalDueMinor: number; currency: 'GBP' | 'EUR' },
  ): Promise<{ attempt: PaymentRecord; redirectUrl: string }> {
    try {
      const created = await provider.createPayment({
        amount: { amountMinor: order.externalDueMinor, currency: order.currency },
        orderReference: order.orderNumber,
        idempotencyKey: attempt.idempotencyKey,
        returnUrl: this.customerUrl(attempt, 'return'),
        cancelUrl: this.customerUrl(attempt, 'cancel'),
      });
      if (attempt.providerReference !== null) {
        return { attempt, redirectUrl: created.redirectUrl };
      }
      // The row has moved on — it has a reference now, and a status to match —
      // so the customer is told about the attempt as it stands, not as it was
      // a moment ago.
      const attached = await this.payments.attachProviderReference(
        this.db,
        attempt.id,
        created.providerReference,
      );
      return { attempt: attached ?? attempt, redirectUrl: created.redirectUrl };
    } catch (error) {
      await this.abandon(attempt, error);
      throw this.providerUnavailable(error);
    }
  }

  /**
   * Finishes an attempt the provider would not start.
   *
   * Without this the customer waits out the full attempt timeout before they
   * can try again, for a failure that already has an answer. Best-effort: if
   * it does not land, the timeout still releases the slot, so nothing is
   * stuck — which is why a failure here is logged rather than raised over the
   * provider error the customer is actually waiting on.
   */
  private async abandon(attempt: PaymentRecord, cause: unknown): Promise<void> {
    const code = cause instanceof PaymentProviderError ? cause.kind : 'provider_error';
    try {
      await this.payments.finish(this.db, attempt.id, 'failed', {
        code,
        message: 'The payment could not be started with the provider.',
      });
    } catch (error) {
      this.logger.error(`could not close attempt ${attempt.id}: ${(error as Error).message}`);
    }
  }

  /** Nothing from the provider's own error reaches the customer. */
  private providerUnavailable(cause: unknown): Error {
    const detail = cause instanceof PaymentProviderError ? cause.kind : 'unknown';
    this.logger.warn(`payment provider refused to start a payment: ${detail}`);
    return Errors.badRequest(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Payments are temporarily unavailable. Try again in a moment.',
    );
  }

  private requireProvider(): PaymentProvider {
    if (!this.provider) {
      // No provider is configured — the correct state in production until O13
      // is answered. Fail closed and say so.
      throw Errors.badRequest('PAYMENT_PROVIDER_UNAVAILABLE', 'Payments are not available yet.');
    }
    return this.provider;
  }

  /** The order is still open for payment, and there is enough time left to try. */
  private assertPayable(order: { status: string; expiresAt: Date }): void {
    if (order.status !== 'awaiting_payment') {
      throw Errors.conflict('ORDER_NOT_PAYABLE', 'This order is no longer awaiting payment.');
    }
    const remainingMs = order.expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      throw Errors.conflict(
        'PAYMENT_DEADLINE_PASSED',
        'The time to pay for this order has passed.',
      );
    }
    // D1b. Not an internal limit but a product behaviour: there is still time
    // on the clock, and not enough of it to finish at a provider, so the
    // customer is told now rather than after they have paid.
    if (remainingMs < this.env.PAYMENT_MIN_WINDOW_SECONDS * 1000) {
      throw Errors.conflict(
        'PAYMENT_WINDOW_TOO_SHORT',
        'There is not enough time left to pay for this order. Add the tickets to your basket again.',
      );
    }
  }

  /**
   * The caller's own order, or a 404.
   *
   * Ownership is decided exactly as `CheckoutService.getOrder` decides it, and
   * someone else's order is indistinguishable from one that is not there.
   */
  private async requireOwnedOrder(
    db: DbExecutor,
    market: MarketContext,
    buyer: OrderBuyer,
    orderId: string,
    lock = false,
  ) {
    if (lock) {
      // Locked first, so the status and the deadline cannot move between the
      // checks below and the attempt being written. This is also the head of
      // the phase's lock order: orders, then payments.
      await sql`SELECT 1 FROM orders WHERE id = ${orderId}::uuid AND market_id = ${market.id}::uuid FOR UPDATE`.execute(
        db,
      );
    }
    const order = await this.orders.findById(db, market.id, orderId);
    if (!order || !this.ownedBy(order.buyer, buyer)) throw Errors.notFound('Order');
    return order;
  }

  /**
   * Who is paying.
   *
   * A guest must have proved the address again if their verification has
   * lapsed, exactly as checkout requires (ADR-0008, ADR-0020). Reading an
   * order back after a lapsed window is what the order access token is for
   * (OD-2, P6-8); STARTING a payment is not a read.
   */
  private buyerOf(identity: CheckoutIdentity): OrderBuyer {
    if (identity.kind === 'user') return { kind: 'user', userId: identity.auth.userId };
    const guest = identity.guest;
    if (!this.guests.hasFreshVerifiedEmail(guest) || !guest.verifiedEmail) {
      throw Errors.badRequest(
        'VERIFICATION_REQUIRED',
        'Verify your email address before paying for your order.',
      );
    }
    return { kind: 'guest', email: guest.verifiedEmail.toLowerCase() };
  }

  private ownedBy(a: OrderBuyer, b: OrderBuyer): boolean {
    if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId;
    if (a.kind === 'guest' && b.kind === 'guest') return a.email === b.email;
    return false;
  }

  /**
   * Where the provider sends the customer back to. P6-8 builds these pages;
   * the provider only needs somewhere to point.
   */
  private customerUrl(attempt: PaymentRecord, outcome: 'return' | 'cancel'): string {
    const origin = this.env.WEB_ORIGINS[0]!;
    return `${origin}/checkout/payments/${attempt.id}/${outcome}`;
  }

  /** The customer-facing view. Never the provider's reference for the attempt. */
  private toDto(attempt: PaymentRecord, orderExpiresAt: Date, redirectUrl: string): Payment {
    return {
      id: attempt.id,
      status: attempt.status,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      redirectUrl,
      expiresAt: attempt.expiresAt.toISOString(),
      orderExpiresAt: orderExpiresAt.toISOString(),
      createdAt: attempt.createdAt.toISOString(),
      serverTime: new Date().toISOString(),
    };
  }
}
