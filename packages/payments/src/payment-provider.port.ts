/**
 * Provider-independent payments (ADR-0006, decision D6; Revision 2 B10).
 *
 * Commerce code depends on this interface and never on a provider SDK. The
 * production provider is OPEN O13 and is deliberately not chosen here: Phase 6
 * ships this port and one fake implementation, and a real adapter is added
 * later as a sibling file without commerce code changing.
 *
 * Four operations, exactly as B10 states them. Adding a fifth would be
 * inventing a requirement, so anything a provider offers beyond these stays
 * behind its own adapter.
 *
 * The specification names the six input and output types but does not define
 * their fields. They are settled here, in the slice where they are cheapest to
 * change, and every field below traces to a stated requirement rather than to
 * what a particular provider happens to send.
 */
import type { Money } from '@hv/domain';

/**
 * Request headers as the HTTP layer hands them over. Matches Fastify's
 * `request.headers`; deliberately not the DOM `Headers`, which does not exist
 * in this runtime's lib.
 */
export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * A payment's state in Highland Vault's vocabulary, not a provider's.
 *
 * Normalising at the adapter edge is the whole point of the port: every
 * provider spells these differently, and no provider's spelling reaches a
 * service. The values match the `payments.status` CHECK that Phase 6 adds, so
 * a status read from a provider and a status read from the database are
 * directly comparable.
 */
export type ProviderPaymentState = 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired';

/** Terminal states: the provider will not change its mind about these. */
export const TERMINAL_PAYMENT_STATES: readonly ProviderPaymentState[] = Object.freeze([
  'succeeded',
  'failed',
  'expired',
]);

export function isTerminalPaymentState(state: ProviderPaymentState): boolean {
  return TERMINAL_PAYMENT_STATES.includes(state);
}

/** A refund's state, normalised the same way. */
export type ProviderRefundState = 'pending' | 'succeeded' | 'failed';

/**
 * What a provider needs to start a payment (B10: "amount, currency, order ref,
 * idempotency key, return URLs").
 */
export interface CreatePaymentInput {
  /** Amount and currency together, so they cannot be passed separately and drift. */
  readonly amount: Money;
  /**
   * The customer-facing order number (`HV-XXXXXXXXXX`), never the order's uuid.
   * It reaches the provider, and from there a statement line and support
   * conversations, so it is the identifier meant to be quoted out loud.
   */
  readonly orderReference: string;
  /** Required by B10 REQ, so a retried create returns the first payment. */
  readonly idempotencyKey: string;
  /** Where the customer comes back to, whatever the outcome. */
  readonly returnUrl: string;
  /** Where the customer goes if they abandon the payment at the provider. */
  readonly cancelUrl: string;
}

export interface CreatedPayment {
  /** The provider's own identifier. Unique per provider (B10 REQ); never shown to a customer. */
  readonly providerReference: string;
  /** Where to send the customer. A redirect here is not, and never becomes, proof of payment. */
  readonly redirectUrl: string;
  /** Almost always `pending`; a provider may report `processing` immediately. */
  readonly state: ProviderPaymentState;
}

/**
 * The answer to a trusted server-side status check (B10). This is one of the
 * only two ways a payment may be confirmed, so it carries the amount: the
 * caller re-checks it against the order before finalising, and a status alone
 * would not let it.
 */
export interface ProviderPaymentStatus {
  readonly providerReference: string;
  readonly state: ProviderPaymentState;
  readonly amount: Money;
}

/**
 * A webhook whose signature has been verified.
 *
 * Carries both the provider's own event type, which is recorded as sent, and
 * the normalised state, which is what the application acts on. They are
 * separate on purpose: the record should say what arrived, and the decision
 * should not depend on a provider's wording.
 */
export interface VerifiedEvent {
  /** The provider's event identifier. Replay protection is built on this being stable and unique. */
  readonly providerEventId: string;
  /** The provider's own event type, stored verbatim. */
  readonly eventType: string;
  readonly providerReference: string;
  readonly state: ProviderPaymentState;
  /** Re-checked against the order before finalisation; a mismatch must not finalise. */
  readonly amount: Money;
  readonly occurredAt: Date;
}

export interface RefundInput {
  /** The payment being refunded. */
  readonly providerReference: string;
  readonly amount: Money;
  /** Required by B10. Derived from the source, so raising a refund twice cannot refund twice. */
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface ProviderRefundResult {
  readonly providerRefundReference: string;
  readonly state: ProviderRefundState;
}

/**
 * Why a provider operation failed.
 *
 * The distinction that matters is whose fault it is, because that decides
 * whether a webhook is retried (D6): a message we cannot verify or parse will
 * be just as invalid next time and must not be retried, while our own failure
 * should be. `provider_unavailable` is the only kind here that is worth
 * retrying, and callers map these to domain errors at the adapter edge so no
 * provider type escapes into a service.
 */
export type PaymentProviderErrorKind =
  /** The signature did not verify. Never retried, never explained to the caller in detail. */
  | 'signature_invalid'
  /** The body could not be read as an event. Never retried. */
  | 'malformed_payload'
  /** No payment matches the reference. Recorded, never revealed to the sender. */
  | 'unknown_reference'
  /** The provider could not be reached or timed out. Retryable. */
  | 'provider_unavailable'
  /** The provider understood and refused. Not retryable without changing something. */
  | 'provider_rejected';

export class PaymentProviderError extends Error {
  override readonly name = 'PaymentProviderError';

  constructor(
    readonly kind: PaymentProviderErrorKind,
    message: string,
  ) {
    super(message);
  }

  /** Whether trying the same operation again could plausibly succeed. */
  get retryable(): boolean {
    return this.kind === 'provider_unavailable';
  }
}

/**
 * Raised when a provider is asked for in an environment that refuses it — the
 * config guard B10 requires around the fake provider. Separate from
 * `PaymentProviderError` because it is a deployment fault, not a payment one,
 * and it should stop startup rather than fail one request.
 */
export class PaymentProviderConfigError extends Error {
  override readonly name = 'PaymentProviderConfigError';
}

/**
 * The four operations. A provider implements exactly these.
 *
 * Note what is absent: nothing marks an order paid. Confirmation is the
 * caller's decision, taken from a verified webhook or a trusted status check
 * (ADR-0006, D6), and a browser redirect is neither.
 */
export interface PaymentProvider {
  /** Stable identifier, stored on every payment row: `'fake'`, later a real provider's. */
  readonly code: string;

  /** Starts a payment and returns where to send the customer. */
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;

  /**
   * Verifies a webhook against the raw request bytes and returns what it says.
   *
   * Throws `PaymentProviderError` on a bad signature or an unreadable body.
   * The bytes must be exactly what arrived: a JSON round trip changes them and
   * every provider's signature is computed over the original.
   */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<VerifiedEvent>;

  /** Asks the provider what actually happened. The trusted confirmation path (B10). */
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus>;

  /** Returns money to the instrument it came from. Idempotent on `idempotencyKey`. */
  refund(input: RefundInput): Promise<ProviderRefundResult>;
}
