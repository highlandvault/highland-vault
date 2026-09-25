/**
 * The fake payment provider (ADR-0006, Revision 2 B10).
 *
 * Used in development and automated tests, and **refused in production by its
 * own constructor** — the config guard B10 requires. Guarding at construction
 * rather than at a call site means there is no way to obtain one in a
 * production build, not merely a check somebody could forget to run.
 *
 * Its job is to misbehave on demand. ADR-0006 requires it to "simulate
 * duplicate, late, out-of-order and missing webhooks", because those are
 * precisely the cases Gate 4 and the Phase 6 concurrency matrix must prove.
 * A provider that only ever behaves correctly would let every idempotency bug
 * through.
 *
 * Everything here is deterministic. Nothing is timed, nothing is random unless
 * the caller leaves the defaults in place, and a test can pin both the clock
 * and the identifiers. Later slices drive real payment flows through this, so
 * a flaky fake would make every payment test flaky.
 *
 * What this file is **not**: it holds no HTTP route, no persistence and no
 * dev-only "complete/fail" page. Those belong to later slices.
 */
import { randomUUID } from 'node:crypto';
import { isCurrency, money, type Money } from '@hv/domain';
import {
  PaymentProviderConfigError,
  PaymentProviderError,
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentProvider,
  type ProviderPaymentState,
  type ProviderPaymentStatus,
  type ProviderRefundResult,
  type RefundInput,
  type VerifiedEvent,
  type WebhookHeaders,
} from './payment-provider.port';
import { FAKE_SIGNATURE_HEADER, signWebhook, verifyWebhookSignature } from './webhook-signature';

export const FAKE_PROVIDER_CODE = 'fake';

/** Environments the fake may run in. Anything else is refused. */
const ALLOWED_ENVIRONMENTS: readonly string[] = Object.freeze(['development', 'test']);

/** What the fake calls each kind of identifier it mints. */
export type FakeIdKind = 'payment' | 'event' | 'refund';

export interface FakePaymentProviderOptions {
  /** The HMAC key webhooks are signed with. A test key; never a production secret. */
  readonly webhookSecret: string;
  /** Usually `NODE_ENV`. `production` is refused. */
  readonly environment: string;
  /** Injectable for deterministic tests. Defaults to the real clock. */
  readonly now?: () => Date;
  /** Injectable for deterministic tests. Defaults to random, so references stay unique. */
  readonly newId?: (kind: FakeIdKind) => string;
}

/**
 * How queued webhooks are handed over.
 *
 * `withheld` is how both "late" and "missing" are simulated: the events stay
 * queued, so a later `takeWebhooks()` delivers them late, and never calling it
 * again means they never arrive at all.
 */
export type WebhookDelivery = 'normal' | 'duplicated' | 'out_of_order' | 'withheld';

/** A webhook exactly as it would arrive over HTTP. */
export interface SignedWebhook {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

/** The wire shape the fake sends. Deliberately small; a real provider sends far more. */
interface FakeEventBody {
  readonly id: string;
  readonly type: string;
  readonly reference: string;
  readonly state: ProviderPaymentState;
  readonly amountMinor: number;
  readonly currency: string;
  readonly occurredAt: string;
}

interface FakePayment {
  readonly reference: string;
  readonly orderReference: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
  state: ProviderPaymentState;
}

const VALID_STATES: readonly ProviderPaymentState[] = Object.freeze([
  'pending',
  'processing',
  'succeeded',
  'failed',
  'expired',
]);

function isPaymentState(value: unknown): value is ProviderPaymentState {
  return typeof value === 'string' && VALID_STATES.includes(value as ProviderPaymentState);
}

export class FakePaymentProvider implements PaymentProvider {
  readonly code = FAKE_PROVIDER_CODE;

  private readonly secret: string;
  private readonly now: () => Date;
  private readonly newId: (kind: FakeIdKind) => string;

  private readonly payments = new Map<string, FakePayment>();
  /** Idempotency key -> payment reference, so a retried create returns the first payment. */
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly refunds = new Map<string, ProviderRefundResult>();
  /** Signed and ready, in the order they occurred. Not yet "delivered". */
  private readonly queue: SignedWebhook[] = [];

  constructor(options: FakePaymentProviderOptions) {
    // The config guard (B10). A production build cannot hold one of these at
    // all, so no later code path can accidentally take payments with it.
    if (!ALLOWED_ENVIRONMENTS.includes(options.environment)) {
      throw new PaymentProviderConfigError(
        `the fake payment provider is not available in ${options.environment}`,
      );
    }
    if (options.webhookSecret.length === 0) {
      throw new PaymentProviderConfigError('the fake payment provider needs a webhook secret');
    }
    this.secret = options.webhookSecret;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((kind) => `fake_${kind}_${randomUUID()}`);
  }

  // ---------------------------------------------------------------- the port

  createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const existingReference = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingReference !== undefined) {
      const existing = this.payments.get(existingReference);
      // Present only for a key this instance minted, so the lookup cannot miss.
      /* c8 ignore next */
      if (existing === undefined) throw new Error('fake provider lost a payment it created');
      return Promise.resolve({
        providerReference: existing.reference,
        redirectUrl: this.redirectUrl(existing.reference, input.returnUrl),
        state: existing.state,
      });
    }

    const reference = this.newId('payment');
    this.payments.set(reference, {
      reference,
      orderReference: input.orderReference,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      state: 'pending',
    });
    this.byIdempotencyKey.set(input.idempotencyKey, reference);
    return Promise.resolve({
      providerReference: reference,
      redirectUrl: this.redirectUrl(reference, input.returnUrl),
      state: 'pending',
    });
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<VerifiedEvent> {
    const signature = headers[FAKE_SIGNATURE_HEADER];
    if (!verifyWebhookSignature(this.secret, rawBody, asSingleHeader(signature))) {
      // No detail about what was wrong: a caller must not be able to probe
      // towards a valid signature.
      return Promise.reject(
        new PaymentProviderError('signature_invalid', 'webhook signature did not verify'),
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return Promise.reject(
        new PaymentProviderError('malformed_payload', 'webhook body is not JSON'),
      );
    }
    const event = readEventBody(body);
    if (event === null) {
      return Promise.reject(
        new PaymentProviderError('malformed_payload', 'webhook body is not a payment event'),
      );
    }
    return Promise.resolve(event);
  }

  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus> {
    const payment = this.payments.get(providerReference);
    if (payment === undefined) {
      return Promise.reject(
        new PaymentProviderError('unknown_reference', 'no payment for that reference'),
      );
    }
    return Promise.resolve({
      providerReference: payment.reference,
      state: payment.state,
      amount: payment.amount,
    });
  }

  refund(input: RefundInput): Promise<ProviderRefundResult> {
    const existing = this.refunds.get(input.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);

    const payment = this.payments.get(input.providerReference);
    if (payment === undefined) {
      return Promise.reject(
        new PaymentProviderError('unknown_reference', 'no payment for that reference'),
      );
    }
    if (payment.state !== 'succeeded') {
      return Promise.reject(
        new PaymentProviderError('provider_rejected', 'only a succeeded payment can be refunded'),
      );
    }
    if (input.amount.currency !== payment.amount.currency) {
      return Promise.reject(
        new PaymentProviderError('provider_rejected', 'refund currency differs from the payment'),
      );
    }
    if (input.amount.amountMinor <= 0 || input.amount.amountMinor > payment.amount.amountMinor) {
      return Promise.reject(
        new PaymentProviderError('provider_rejected', 'refund amount is outside the payment'),
      );
    }

    const result: ProviderRefundResult = {
      providerRefundReference: this.newId('refund'),
      state: 'succeeded',
    };
    this.refunds.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  // ------------------------------------------- the dev and test control surface
  //
  // Not part of PaymentProvider. Nothing in production may reach these, which
  // the constructor guard already guarantees.

  /** The customer completes the payment. Queues a `payment.succeeded` webhook. */
  complete(providerReference: string): void {
    this.transition(providerReference, 'succeeded', 'payment.succeeded');
  }

  /** The payment fails at the provider. Queues a `payment.failed` webhook. */
  fail(providerReference: string): void {
    this.transition(providerReference, 'failed', 'payment.failed');
  }

  /** The provider's own session lapses. Queues a `payment.expired` webhook. */
  expire(providerReference: string): void {
    this.transition(providerReference, 'expired', 'payment.expired');
  }

  /** How many webhooks are queued but not yet handed over. */
  get pendingWebhooks(): number {
    return this.queue.length;
  }

  /**
   * Hands over the queued webhooks, or misbehaves as asked.
   *
   * `withheld` returns nothing and keeps the queue, which is how both "late"
   * and "missing" are simulated: deliver them on a later call, or never.
   */
  takeWebhooks(delivery: WebhookDelivery = 'normal'): SignedWebhook[] {
    if (delivery === 'withheld') return [];
    const queued = this.queue.splice(0, this.queue.length);
    switch (delivery) {
      case 'normal':
        return queued;
      case 'duplicated':
        return queued.flatMap((webhook) => [webhook, webhook]);
      case 'out_of_order':
        return queued.reverse();
    }
  }

  // -------------------------------------------------------------- internals

  private transition(
    providerReference: string,
    state: ProviderPaymentState,
    eventType: string,
  ): void {
    const payment = this.payments.get(providerReference);
    if (payment === undefined) {
      throw new PaymentProviderError('unknown_reference', 'no payment for that reference');
    }
    payment.state = state;
    this.queue.push(
      this.sign({
        id: this.newId('event'),
        type: eventType,
        reference: payment.reference,
        state,
        amountMinor: payment.amount.amountMinor,
        currency: payment.amount.currency,
        occurredAt: this.now().toISOString(),
      }),
    );
  }

  private sign(body: FakeEventBody): SignedWebhook {
    // Serialised once, and the signature covers exactly these bytes. Callers
    // must post `rawBody` unchanged; re-serialising it breaks the signature,
    // which is the behaviour P6-3 has to be built against.
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: signWebhook(this.secret, rawBody),
      },
    };
  }

  /** Where the customer would be sent. A return from here proves nothing (D6). */
  private redirectUrl(reference: string, returnUrl: string): string {
    const url = new URL('https://fake-provider.invalid/pay');
    url.searchParams.set('reference', reference);
    url.searchParams.set('return_to', returnUrl);
    return url.toString();
  }
}

/** A repeated header is not something a provider should send; treat it as absent. */
function asSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads the wire body into a VerifiedEvent, or null if it is not one. */
function readEventBody(body: unknown): VerifiedEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Partial<Record<keyof FakeEventBody, unknown>>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.reference !== 'string' ||
    typeof candidate.occurredAt !== 'string' ||
    typeof candidate.amountMinor !== 'number' ||
    typeof candidate.currency !== 'string' ||
    !isPaymentState(candidate.state)
  ) {
    return null;
  }
  const occurredAt = new Date(candidate.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return null;
  if (!isCurrency(candidate.currency)) return null;

  let amount: Money;
  try {
    // `money` rejects anything that is not a safe integer of minor units, so a
    // payload claiming 10.5 pence never becomes a VerifiedEvent.
    amount = money(candidate.amountMinor, candidate.currency);
  } catch {
    return null;
  }

  return {
    providerEventId: candidate.id,
    eventType: candidate.type,
    providerReference: candidate.reference,
    state: candidate.state,
    amount,
    occurredAt,
  };
}
