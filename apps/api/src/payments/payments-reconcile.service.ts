import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, sql } from '@hv/db';
import type { RequestMeta } from '../common/request-context';
import { PaymentProviderError } from '@hv/payments';
import { AuditService, type AuditActor } from '../audit/audit.service';
import { DATABASE } from '../database/database.module';
import { PaymentProviderRegistry } from './payment-provider.registry';
import {
  PaymentFinalizationService,
  type FinalizationOutcome,
} from './payment-finalization.service';

/**
 * The audit action for an anomaly a reconciliation found (D-2).
 *
 * Distinct from `payment.reconciled`, which records that somebody ASKED. This
 * records that something is WRONG, and the two are different facts: an
 * operator-triggered check that finds a second capture writes both, because a
 * person asked and an anomaly was found.
 */
const ANOMALY_ACTION = 'payment.anomaly_detected';
import { PaymentsRepository } from './payments.repository';

/** Request attribution, as `AuditService` takes it. */
type ReconcileMeta = Pick<RequestMeta, 'ip' | 'requestId'>;

/** What a trusted status check came to. */
export type ReconcileOutcome =
  /** The provider was asked and its answer was applied by finalisation. */
  | {
      readonly kind: 'checked';
      readonly providerState: string;
      readonly outcome: FinalizationOutcome;
    }
  /** We have no such attempt. Indistinguishable, to a caller, from one we will not discuss. */
  | { readonly kind: 'unknown_payment' }
  /** The attempt never got a provider reference, so there is nothing to ask about. */
  | { readonly kind: 'no_provider_reference' }
  /** The provider could not be reached. Nothing was changed. */
  | { readonly kind: 'provider_unavailable'; readonly detail: string };

/**
 * The trusted provider status check (Revision 2 B10; OD-5; D12 = A, D12a).
 *
 * **The only way a payment is confirmed other than a verified webhook**, and
 * the thing B10 means when it says a redirect can never mark an order paid. A
 * customer's browser is not an input here; the provider is asked directly,
 * server to server.
 *
 * Every caller reaches the same method — the worker's 60-second reconciler
 * through the internal listener, an operator through the admin route, and the
 * customer status route when it is allowed to look. They differ in who is
 * permitted and what they are told back, never in what happens to the money.
 *
 * **A caller supplies a payment id and nothing else.** Provider, order, market,
 * currency and amount are all read from the row, so there is no field anyone
 * could send that would move an order in another market or change what is
 * owed. The attempt's composite foreign keys are what make that a property of
 * the schema rather than of this method's care.
 *
 * **The provider is called before any transaction is opened** (OD-5). A network
 * call inside the finalisation transaction would hold the order lock for as
 * long as a provider felt like taking, against an expiry sweep that wants the
 * same rows.
 *
 * **Finalisation is not reimplemented here.** The provider's answer is mapped
 * into the same `ConfirmationClaim` a webhook produces and handed to the same
 * `confirm`, so idempotency, the amount and currency re-checks, D21, D22 and
 * D23 all apply identically however the claim arrived.
 */
@Injectable()
export class PaymentsReconcileService {
  private readonly logger = new Logger(PaymentsReconcileService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly providers: PaymentProviderRegistry,
    private readonly payments: PaymentsRepository,
    private readonly finalization: PaymentFinalizationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Asks the provider what happened to one attempt, and applies the answer.
   *
   * Safe to call any number of times: it writes nothing itself, and everything
   * it delegates to is idempotent. It never moves an order out of a terminal
   * state, because `confirm` will not.
   */
  async reconcile(paymentId: string): Promise<ReconcileOutcome> {
    const payment = await this.payments.findById(this.db, paymentId);
    if (!payment) return { kind: 'unknown_payment' };
    if (!payment.providerReference) {
      // The provider never named this attempt, so there is nothing to ask
      // about. Left exactly as it is; attempt expiry will close it.
      return { kind: 'no_provider_reference' };
    }
    // P6-7: the provider is resolved from the payment’s own MARKET, and the
    // attempt must name the provider that market is configured for. A payment
    // taken through one provider is never re-checked against another.
    const provider = await this.providers.forMarket(this.db, payment.marketId);
    if (!provider || provider.code !== payment.provider) {
      return { kind: 'provider_unavailable', detail: 'no_provider_configured' };
    }

    // OUTSIDE any transaction, holding no lock (OD-5).
    let state: string;
    let amountMinor: number;
    let currency: string;
    try {
      const status = await provider.getPaymentStatus(payment.providerReference);
      state = status.state;
      amountMinor = status.amount.amountMinor;
      currency = status.amount.currency;
    } catch (error) {
      const detail = error instanceof PaymentProviderError ? error.kind : 'unknown';
      // Nothing is written. Not the payment, not the order, not a ticket. A
      // provider we could not reach has told us nothing, and the next run
      // re-derives its work from the database anyway.
      this.logger.warn(`could not read payment ${payment.id} from the provider: ${detail}`);
      return { kind: 'provider_unavailable', detail };
    }

    // The same claim shape a verified webhook produces, with no event behind
    // it — see `ConfirmationClaim.eventId`.
    const outcome = await this.finalization.confirm({
      eventId: null,
      paymentId: payment.id,
      state,
      amountMinor,
      currency,
    });
    await this.recordAnomaly(payment, outcome);
    return { kind: 'checked', providerState: state, outcome };
  }

  /**
   * Writes a durable record of an anomaly this reconciliation discovered.
   *
   * **Why this exists.** A webhook that turns out to be a second capture is
   * recorded on its `payment_events` row, and the reconciler's unprocessed
   * index finds it. A reconciliation has no delivery to write on — the
   * provider was asked directly — and fabricating one would poison
   * `UNIQUE (provider, provider_event_id)`, the phase's replay protection. So
   * the record goes where a fact with no document of its own belongs: the
   * audit log. Without this the only trace was a log line, and a reason nobody
   * can query for is not a record.
   *
   * **Only the two anomalies.** An ordinary check that finds nothing, or
   * finalises normally, writes nothing here — `confirm` already audits what it
   * did to the order. This is for the outcomes that mean money is unaccounted
   * for and **nothing was done about it**: `second_capture` (D22.1) and
   * `capture_without_settlement` (I24, K-3).
   *
   * **It does not settle anything.** The event, where there is one, stays
   * unprocessed; the payment and the order are untouched. Auditing that
   * something is owed is not the same as dealing with it, and this must never
   * be mistaken for having dealt with it.
   *
   * **Actor is `system`**, the convention `audit_log` already carries
   * (`actor_type IN ('user','system')`, `actor_user_id` NULL for system) and
   * that P6-4 already uses. No user is invented and no schema is changed.
   */
  private async recordAnomaly(
    payment: { id: string; orderId: string; marketId: string; provider: string },
    outcome: FinalizationOutcome,
  ): Promise<void> {
    if (outcome.kind !== 'second_capture' && outcome.kind !== 'capture_without_settlement') {
      return;
    }
    // One record per payment per anomaly. The worklist keeps a stuck attempt in
    // scope for five minutes and the status route may be polled inside its own
    // limit, so without this the same unchanged fact would be restated every
    // time somebody looked. A genuinely different anomaly on the same payment
    // still gets its own row, because the outcome is part of the key.
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM audit_log
       WHERE action = ${ANOMALY_ACTION}
         AND entity_id = ${payment.orderId}
         AND after ->> 'paymentId' = ${payment.id}
         AND after ->> 'outcome' = ${outcome.kind}
    `.execute(this.db);
    if ((rows[0]?.n ?? 0) > 0) return;

    await this.audit.record(this.db, {
      // No human found this. A scheduled check or a customer's own page did.
      actor: { type: 'system' },
      action: ANOMALY_ACTION,
      entityType: 'order',
      entityId: payment.orderId,
      marketId: payment.marketId,
      reason: outcome.kind,
      after: {
        paymentId: payment.id,
        orderId: payment.orderId,
        provider: payment.provider,
        outcome: outcome.kind,
        // How it was found, so an operator can tell a provider message from a
        // direct question to the provider.
        source: 'reconciliation',
        ...(outcome.kind === 'second_capture'
          ? { settledByPaymentId: outcome.settledByPaymentId }
          : { orderStatus: outcome.status }),
      },
    });
    this.logger.error(
      `reconciliation found ${outcome.kind} on order ${payment.orderId} (payment ${payment.id})`,
    );
  }

  /**
   * Reconciles, and records who asked (OD-5).
   *
   * Every invocation is audited, whether or not anything moved: "we asked the
   * provider about this payment and it said nothing had changed" is exactly the
   * kind of thing an operator needs to be able to prove afterwards. The audit
   * row is separate from any `confirm` writes, and deliberately so — it records
   * the request, not the outcome's effect on the order.
   */
  async reconcileAs(
    paymentId: string,
    actor: AuditActor,
    context: { marketId: string; orderId: string; reason: string; meta?: ReconcileMeta },
  ): Promise<ReconcileOutcome> {
    const result = await this.reconcile(paymentId);
    await this.audit.record(this.db, {
      actor,
      action: 'payment.reconciled',
      entityType: 'order',
      entityId: context.orderId,
      marketId: context.marketId,
      reason: context.reason,
      after: {
        paymentId,
        result: result.kind,
        ...(result.kind === 'checked'
          ? { providerState: result.providerState, outcome: result.outcome.kind }
          : {}),
      },
      ...(context.meta ? { meta: context.meta } : {}),
    });
    return result;
  }
}
