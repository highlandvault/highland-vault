import { z } from 'zod';

/**
 * Payment attempts (Revision 2 B10; ADR-0006; Phase 6 decisions D3, D3a, D3b).
 *
 * Phase 6 starts a payment. It does not confirm one: a customer returning from
 * a provider proves nothing, and only a verified webhook or a trusted
 * server-side status check can move an order to `paid`.
 *
 * Note what a client never sends and never receives. It sends no amount — the
 * order is the only authority on what is owed (I4, I5) — and it is never told
 * the provider's own reference for the attempt, which is an internal
 * identifier and a thing worth guessing.
 */

/** POST /markets/:market/checkout/orders/:order/payments — the body carries nothing. */
export const CreatePaymentRequestSchema = z.strictObject({});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;

export const PaymentSchema = z.object({
  id: z.uuid(),
  /**
   * Where this attempt stands.
   *
   * `pending` and `processing` are live; the rest are terminal for the
   * attempt, though `failed` and `expired` leave the ORDER payable — the
   * customer may start another attempt while their deadline holds.
   */
  status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'expired']),
  /** What is owed, taken from the order. Always equal to the order's `externalDueMinor`. */
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR']),
  /** Where to send the customer. Coming back from here is not proof of payment. */
  redirectUrl: z.url(),
  /** When this attempt stops being usable (D3a). Never later than the order's deadline. */
  expiresAt: z.iso.datetime(),
  /** The order's own payment deadline, so a countdown has something honest to count to. */
  orderExpiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  /** Authoritative time, so a countdown does not depend on the browser's clock. */
  serverTime: z.iso.datetime(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const PaymentResponseSchema = z.object({ payment: PaymentSchema });
export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;
