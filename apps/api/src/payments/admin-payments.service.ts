import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AdminOpenPayloadResponse,
  AdminOrderPaymentsResponse,
  AdminPaymentEvent,
  AdminRefundDuplicateResponse,
  AdminReconcileResponse,
} from '@hv/contracts';
import { type Database, sql } from '@hv/db';
import { SecretBox, openPayload } from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { MarketsRepository } from '../markets/markets.repository';
import { OrdersRepository } from '../orders/orders.repository';
import { PaymentsReconcileService } from './payments-reconcile.service';
import { PaymentsRepository } from './payments.repository';
import { RefundsService } from './refunds.service';

/**
 * The staff view of how an order was paid for, and the two things staff may do
 * about it (Revision 2 B10; OD-5; D13a; OD-7a).
 *
 * **Every relationship is derived here, never accepted.** A caller names a
 * market, an order, and sometimes a payment or an event; this service proves
 * from the database that they belong together before anything happens. A
 * payment of another market's order is a 404, not a 403 — the same answer as
 * one that does not exist, so the admin surface is not an oracle for which
 * identifiers are real.
 *
 * **Viewing and acting are different authorities (D13 = B).** Reading is
 * `orders.read`, which every staff role already holds. Asking the provider
 * what happened, opening a sealed payload, and refunding a duplicate capture
 * are all `payments.reconcile`, sensitive, and audited — and the routes, not
 * this service, are where that is enforced.
 */
@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly markets: MarketsRepository,
    private readonly orders: OrdersRepository,
    private readonly payments: PaymentsRepository,
    private readonly reconcile: PaymentsReconcileService,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything about an order's payments that `orders.read` may see.
   *
   * Normalised facts only. No provider reference, no sealed payload, no raw
   * body — those are `payments.reconcile`'s, and a view that leaked them would
   * hand every support agent the ability to read a customer's provider data.
   */
  async view(marketCode: string, orderId: string): Promise<AdminOrderPaymentsResponse> {
    const order = await this.requireOrder(marketCode, orderId);

    const attempts = await this.payments.listForOrder(this.db, order.id);
    const { rows: events } = await sql<{
      id: string;
      event_type: string;
      provider_status: string | null;
      payment_id: string | null;
      received_at: Date;
      processed_at: Date | null;
      last_error: string | null;
      has_payload: boolean;
    }>`
      SELECT e.id, e.event_type, e.provider_status, e.payment_id, e.received_at,
             e.processed_at, e.last_error, (e.payload_sealed IS NOT NULL) AS has_payload
        FROM payment_events e
        JOIN payments p ON p.id = e.payment_id
       WHERE p.order_id = ${order.id}::uuid
       ORDER BY e.received_at
    `.execute(this.db);

    const { rows: refunds } = await sql<{
      id: string;
      status: string;
      destination: string;
      amount_minor: string | number;
      currency: string;
      reason: string;
      payment_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>`
      SELECT id, status, destination, amount_minor, currency, reason, payment_id,
             created_at, updated_at
        FROM refunds WHERE order_id = ${order.id}::uuid ORDER BY created_at
    `.execute(this.db);

    return {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        externalDueMinor: order.externalDueMinor,
        currency: order.currency,
        expiresAt: order.expiresAt.toISOString(),
      },
      attempts: attempts.map((a) => ({
        id: a.id,
        status: a.status,
        amountMinor: a.amountMinor,
        currency: a.currency,
        provider: a.provider,
        // Whether the provider named it, never what it named it. The reference
        // is an internal identifier and a thing worth guessing.
        hasProviderReference: a.providerReference !== null,
        failureCode: a.failureCode,
        expiresAt: a.expiresAt.toISOString(),
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      events: events.map((e): AdminPaymentEvent => ({
        id: e.id,
        eventType: e.event_type,
        providerStatus: e.provider_status,
        paymentId: e.payment_id,
        receivedAt: e.received_at.toISOString(),
        processedAt: e.processed_at?.toISOString() ?? null,
        lastError: e.last_error,
        hasSealedPayload: e.has_payload,
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        status: r.status as 'raised' | 'succeeded' | 'failed',
        destination: r.destination as 'provider' | 'wallet',
        amountMinor: Number(r.amount_minor),
        currency: r.currency as 'GBP' | 'EUR',
        reason: r.reason,
        paymentId: r.payment_id,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }

  /**
   * An operator asks the provider what really happened (OD-5).
   *
   * The same path the worker's reconciler takes, and the same `confirm` a
   * webhook reaches. An operator cannot make an outcome happen that the rules
   * would not have produced on their own — they can only cause the question to
   * be asked now rather than on the next tick.
   */
  async reconcilePayment(
    marketCode: string,
    orderId: string,
    paymentId: string,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminReconcileResponse> {
    const order = await this.requireOrder(marketCode, orderId);
    const payment = await this.payments.findById(this.db, paymentId);
    // Derived, not trusted: the payment must be this order's, and the order
    // must be this market's. Neither is taken from the request.
    if (!payment || payment.orderId !== order.id) throw Errors.notFound('Payment');

    const result = await this.reconcile.reconcileAs(
      payment.id,
      { type: 'user', userId: auth.userId },
      {
        marketId: order.marketId,
        orderId: order.id,
        reason,
        meta: { ip: meta.ip, requestId: meta.requestId },
      },
    );
    return {
      result: result.kind,
      outcome: result.kind === 'checked' ? result.outcome.kind : null,
    };
  }

  /**
   * Opens one sealed provider payload (OD-7a, ADR-0033).
   *
   * An explicit operator action with a reason, audited before the plaintext
   * exists in this process. It is returned once to the caller and written
   * nowhere: not to a log line, not to the audit row, not to any other
   * response. The audit records THAT it was opened and by whom, which is the
   * part that must survive; the contents are the part that must not.
   */
  async openEventPayload(
    marketCode: string,
    orderId: string,
    eventId: string,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminOpenPayloadResponse> {
    const order = await this.requireOrder(marketCode, orderId);
    const event = await this.requireEventOfOrder(order.id, eventId);
    if (event.payload_sealed === null) {
      // Retention has cleared it (OD-7a: 90 days). The row is kept; the
      // payload is gone and does not come back.
      throw Errors.notFound('Payload');
    }

    await this.audit.record(this.db, {
      actor: { type: 'user', userId: auth.userId },
      action: 'payment.payload_opened',
      entityType: 'order',
      entityId: order.id,
      marketId: order.marketId,
      reason,
      // The event, never the payload.
      after: { paymentEventId: event.id },
      meta: { ip: meta.ip, requestId: meta.requestId },
    });

    const box = new SecretBox(this.env.OUTBOX_ENCRYPTION_KEY, this.env.OUTBOX_ENCRYPTION_KEY_ID);
    const opened = openPayload<{ raw: string }>(
      box,
      // The same associated data P6-3 sealed it under, so a payload moved onto
      // another row will not open here either.
      `payment_event:${event.provider}:${event.provider_event_id}`,
      event.payload_sealed,
    );
    return { eventId: event.id, payloadBase64: opened.raw };
  }

  /**
   * Refunds a capture the provider made twice (D22.3).
   *
   * Invoked, never automatic, and never reachable from webhook intake or the
   * reconciler. `RefundsService` itself refuses any event this system did not
   * classify `second_capture`, so an operator cannot aim this at an ordinary
   * duplicate delivery even by trying.
   */
  async refundDuplicate(
    marketCode: string,
    orderId: string,
    eventId: string,
    reason: string,
    auth: AuthContext,
    meta: RequestMeta,
  ): Promise<AdminRefundDuplicateResponse> {
    const order = await this.requireOrder(marketCode, orderId);
    const event = await this.requireEventOfOrder(order.id, eventId);

    const outcome = await this.refunds.refundDuplicateCapture(event.id);
    await this.audit.record(this.db, {
      actor: { type: 'user', userId: auth.userId },
      action: 'payment.duplicate_capture_refund_requested',
      entityType: 'order',
      entityId: order.id,
      marketId: order.marketId,
      reason,
      after: { paymentEventId: event.id, result: outcome.kind },
      meta: { ip: meta.ip, requestId: meta.requestId },
    });
    if (outcome.kind === 'not_a_duplicate_capture') {
      this.logger.warn(`event ${event.id} is not a confirmed duplicate capture`);
      return { result: 'not_a_duplicate_capture', refundId: null };
    }
    return { result: outcome.kind, refundId: outcome.refundId };
  }

  // ------------------------------------------------------------- internals

  /** The order, proven to be this market's. Anything else is a 404. */
  private async requireOrder(marketCode: string, orderId: string) {
    const market = await this.markets.findByCode(this.db, marketCode);
    if (!market) throw Errors.notFound('Market');
    const order = await this.orders.findById(this.db, market.id, orderId);
    if (!order) throw Errors.notFound('Order');
    return order;
  }

  /** The event, proven to belong to an attempt of this order. */
  private async requireEventOfOrder(orderId: string, eventId: string) {
    const { rows } = await sql<{
      id: string;
      provider: string;
      provider_event_id: string;
      payload_sealed: unknown;
    }>`
      SELECT e.id, e.provider, e.provider_event_id, e.payload_sealed
        FROM payment_events e
        JOIN payments p ON p.id = e.payment_id
       WHERE e.id = ${eventId}::uuid AND p.order_id = ${orderId}::uuid
    `.execute(this.db);
    const event = rows[0];
    if (!event) throw Errors.notFound('Payment event');
    return event;
  }
}
