import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Database } from '@hv/db';
import { SecretBox, sealPayload } from '@hv/domain';
import {
  PaymentProviderError,
  type PaymentProvider,
  type VerifiedEvent,
  type WebhookHeaders,
} from '@hv/payments';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { Errors } from '../common/errors';
import { OrdersRepository } from '../orders/orders.repository';
import { PAYMENT_PROVIDER } from '../payments/payment-provider.factory';
import { PaymentsRepository } from '../payments/payments.repository';
import { PaymentEventsRepository } from './payment-events.repository';

/**
 * Why an event needed nothing further. Short codes, so they can be counted and
 * queried rather than read.
 */
export type SettledReason =
  /** No attempt of ours carries that reference. Kept, never revealed to the sender. */
  | 'unknown_reference'
  /** A status that decides nothing: the customer is still with the provider. */
  | 'not_actionable'
  /** The provider named an amount that is not what the order is owed. */
  | 'amount_mismatch'
  /** The provider named a currency that is not the order's. */
  | 'currency_mismatch';

/** What became of a delivery. Returned for tests and logs; providers get a bare 200. */
export type IntakeOutcome =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'settled'; readonly eventId: string; readonly reason: SettledReason }
  | { readonly kind: 'awaiting_finalisation'; readonly eventId: string };

/** The provider statuses that could move an order, and so are worth acting on. */
const ACTIONABLE_STATUSES: readonly string[] = ['succeeded', 'failed', 'expired'];

/**
 * Receiving a provider webhook (Revision 2 B10 step 2; ADR-0006; Phase 6
 * decisions D5 = B, D6 = C, D7 = B).
 *
 * **This service stores and acknowledges. It finalises nothing.** No order
 * status moves here, no ticket is sold, no outbox event is written. Deciding
 * that an order was paid is one transaction with its own invariants, and P6-4
 * owns it; separating the two is deliberate, because storing what arrived and
 * acting on it have entirely different failure modes.
 *
 * What this does own is the boundary. Nothing that arrives here is trusted
 * until its signature verifies over the exact bytes, and after that its
 * contents are still only a claim: the amount and currency are checked against
 * the ORDER before an event is allowed to mean anything, because a provider
 * saying an order was paid does not make it so at that amount.
 *
 * Failures are classified by whose they are (D6 = C). A message we cannot
 * verify or read is refused and not retried — it will be exactly as invalid
 * next time. A failure of ours answers 5xx so the provider tries again, and
 * leaves the stored event unsettled so a job can pick it up as well.
 */
@Injectable()
export class WebhookIntakeService {
  private readonly logger = new Logger(WebhookIntakeService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
    private readonly events: PaymentEventsRepository,
    private readonly payments: PaymentsRepository,
    private readonly orders: OrdersRepository,
  ) {}

  /**
   * Verifies a delivery and records it.
   *
   * Throws only for the provider's own faults — an unregistered provider, a
   * signature that does not verify, a body that cannot be read — and those are
   * refused rather than retried. Anything else is a fault of ours and reaches
   * the caller as a 5xx.
   */
  async receive(
    providerCode: string,
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<IntakeOutcome> {
    const provider = this.resolveProvider(providerCode);
    const event = await this.verify(provider, rawBody, headers);

    // Matched before the insert so the row records which attempt it belongs to.
    // An event for a reference we never issued is still kept: a provider
    // re-sending something old, or addressing the wrong deployment, is a thing
    // to have a record of rather than to discard.
    const payment = await this.payments.findByProviderReference(
      this.db,
      provider.code,
      event.providerReference,
    );

    const stored = await this.events.insertIfNew(this.db, {
      provider: provider.code,
      providerEventId: event.providerEventId,
      eventType: event.eventType,
      providerReference: event.providerReference,
      paymentId: payment?.id ?? null,
      amountMinor: event.amount.amountMinor,
      currency: event.amount.currency,
      providerStatus: event.state,
      // The original bytes, sealed (D7 = B). Base64 inside the envelope, so
      // what is kept is exactly what arrived rather than a re-serialisation of
      // what we understood. Bound to this event's identity, so a sealed
      // payload moved to another row will not open.
      payloadSealed: sealPayload(this.secretBox(), this.sealingContext(provider.code, event), {
        raw: rawBody.toString('base64'),
      }),
    });

    if (!stored) {
      // Already recorded. Replay protection did its job and there is nothing
      // to do — not even a second look at it (B10 step 2).
      return { kind: 'duplicate' };
    }

    if (!payment) {
      await this.events.settle(this.db, stored.id, 'unknown_reference');
      return { kind: 'settled', eventId: stored.id, reason: 'unknown_reference' };
    }

    if (!ACTIONABLE_STATUSES.includes(event.state)) {
      // `pending` and `processing` say the customer is still at the provider,
      // and an event type we do not recognise arrives here too. Both are kept
      // and settled rather than dropped: the record says what came, and
      // nothing is owed on it.
      await this.events.settle(this.db, stored.id, 'not_actionable');
      return { kind: 'settled', eventId: stored.id, reason: 'not_actionable' };
    }

    const mismatch = await this.checkAgainstOrder(payment, event);
    if (mismatch) {
      // The provider's claim disagrees with the order. This must never become a
      // finalisation, so it is settled here with the reason, and the order is
      // left exactly as it was.
      this.logger.warn(`provider event ${stored.id} disagrees with its order: ${mismatch}`);
      await this.events.settle(this.db, stored.id, mismatch);
      return { kind: 'settled', eventId: stored.id, reason: mismatch };
    }

    // Left unsettled on purpose. It should move an order, and moving one is
    // finalisation's job (P6-4), which reads exactly the events that are still
    // waiting.
    return { kind: 'awaiting_finalisation', eventId: stored.id };
  }

  // ------------------------------------------------------------- internals

  private resolveProvider(code: string): PaymentProvider {
    if (!this.provider || this.provider.code !== code) {
      // Unknown, or none configured. A 404 with no detail: a caller learns
      // nothing about which providers this deployment speaks to.
      throw Errors.notFound('Webhook');
    }
    return this.provider;
  }

  /**
   * The provider's own verification, and nothing of ours.
   *
   * The bytes are handed over exactly as they arrived. Anything that fails here
   * is the sender's fault and is refused without detail — saying whether a
   * signature was wrong or a body unreadable would help somebody work towards
   * a valid one.
   */
  private async verify(
    provider: PaymentProvider,
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<VerifiedEvent> {
    try {
      return await provider.verifyWebhook(rawBody, headers);
    } catch (error) {
      const kind = error instanceof PaymentProviderError ? error.kind : 'unknown';
      // The event id, the signature and the body are all absent from this on
      // purpose: one is not known yet and the other two are never logged.
      this.logger.warn(`rejected a ${provider.code} webhook: ${kind}`);
      throw Errors.badRequest('BAD_REQUEST', 'The request is malformed.');
    }
  }

  /**
   * Whether the event's money matches the order's (I4, I6).
   *
   * The order is the only authority on what is owed. A provider reporting a
   * different amount or currency is not corrected and not trusted — it is
   * recorded and stopped, because the alternative is selling tickets for a
   * sum nobody agreed to.
   */
  private async checkAgainstOrder(
    payment: { orderId: string; marketId: string },
    event: VerifiedEvent,
  ): Promise<'amount_mismatch' | 'currency_mismatch' | null> {
    const order = await this.orders.findById(this.db, payment.marketId, payment.orderId);
    if (!order) {
      // The attempt's composite foreign key makes this unreachable; treated as
      // ours rather than the provider's, so it retries instead of vanishing.
      throw new Error(`payment ${payment.orderId} has no order`);
    }
    if (event.amount.currency !== order.currency) return 'currency_mismatch';
    if (event.amount.amountMinor !== order.externalDueMinor) return 'amount_mismatch';
    return null;
  }

  /**
   * The associated data a payload is sealed under.
   *
   * It binds the ciphertext to this event's identity, so a sealed payload
   * copied onto another row will not open — the same reasoning ADR-0028 uses
   * when it binds an outbox payload to its topic.
   */
  private sealingContext(provider: string, event: VerifiedEvent): string {
    return `payment_event:${provider}:${event.providerEventId}`;
  }

  private secretBox(): SecretBox {
    return new SecretBox(this.env.OUTBOX_ENCRYPTION_KEY, this.env.OUTBOX_ENCRYPTION_KEY_ID);
  }
}
