import { z } from 'zod';
import { MarketCodeSchema } from './markets';

/** Sensitive operations always carry a non-empty reason, stored in the audit log (ADR-0010). */
export const ReasonSchema = z.string().trim().min(3).max(500);

/** The full gate state of a market, for staff. */
export const AdminMarketSchema = z.object({
  code: MarketCodeSchema,
  name: z.string(),
  currency: z.enum(['GBP', 'EUR']),
  locale: z.string(),
  isEnabled: z.boolean(),
  /** Layer 2: whether ENABLED_MARKETS on this API instance allows the market. */
  environmentAllowed: z.boolean(),
  /** Enabled AND allowed by the environment. */
  available: z.boolean(),
  requiresLegalApproval: z.boolean(),
  legalApproval: z
    .object({
      approvedAt: z.iso.datetime(),
      approvedBy: z.uuid(),
      reference: z.string(),
    })
    .nullable(),
  settings: z.object({
    minAge: z.number().int().nullable(),
    selfExclusionRequired: z.boolean().nullable(),
  }),
  /** Required compliance settings that are still unset (OPEN O12). */
  missingSettings: z.array(z.string()),
});
export type AdminMarket = z.infer<typeof AdminMarketSchema>;

/** GET /admin/markets */
export const AdminMarketListResponseSchema = z.object({ markets: z.array(AdminMarketSchema) });
export type AdminMarketListResponse = z.infer<typeof AdminMarketListResponseSchema>;

/** Response of every market gate operation. */
export const AdminMarketResponseSchema = z.object({ market: AdminMarketSchema });
export type AdminMarketResponse = z.infer<typeof AdminMarketResponseSchema>;

/** PUT /admin/markets/:market/settings — values are entered by staff, never defaulted. */
export const UpdateMarketSettingsRequestSchema = z.strictObject({
  minAge: z.number().int().min(1).max(99).nullable(),
  selfExclusionRequired: z.boolean().nullable(),
  reason: ReasonSchema,
});
export type UpdateMarketSettingsRequest = z.infer<typeof UpdateMarketSettingsRequestSchema>;

/** POST /admin/markets/:market/legal-approval */
export const RecordLegalApprovalRequestSchema = z.strictObject({
  reference: z.string().trim().min(1).max(200),
  reason: ReasonSchema,
});
export type RecordLegalApprovalRequest = z.infer<typeof RecordLegalApprovalRequestSchema>;

/** POST /admin/markets/:market/enable and /disable */
export const MarketGateChangeRequestSchema = z.strictObject({ reason: ReasonSchema });
export type MarketGateChangeRequest = z.infer<typeof MarketGateChangeRequestSchema>;

/**
 * Staff view of an order's payment attempts (D13a).
 *
 * Normalised facts only. There is deliberately no provider reference, no sealed
 * payload and no raw webhook body here: this is the view `orders.read` grants,
 * and `orders.read` reaches every staff role. Opening a sealed payload is a
 * separate, sensitive, audited action under `payments.reconcile`.
 */
export const AdminPaymentAttemptSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'expired']),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR']),
  provider: z.string(),
  /** Whether the provider ever named this attempt. Never the reference itself. */
  hasProviderReference: z.boolean(),
  failureCode: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminPaymentAttempt = z.infer<typeof AdminPaymentAttemptSchema>;

/** A provider delivery, as staff see it. Normalised columns, never the payload. */
export const AdminPaymentEventSchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  providerStatus: z.string().nullable(),
  paymentId: z.uuid().nullable(),
  receivedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
  /**
   * Why it needs attention, or null.
   *
   * `second_capture` and `capture_without_settlement` are reconciliation
   * exceptions left unprocessed on purpose (D22.1, I23, I24). They appear here
   * so an operator finds them; nothing acts on them automatically.
   */
  lastError: z.string().nullable(),
  /** True when the sealed original is still retained (OD-7a: 90 days). */
  hasSealedPayload: z.boolean(),
});
export type AdminPaymentEvent = z.infer<typeof AdminPaymentEventSchema>;

/** A refund raised against the order. Phase 6 raises; P10 manages. */
export const AdminRefundSchema = z.object({
  id: z.uuid(),
  status: z.enum(['raised', 'succeeded', 'failed']),
  destination: z.enum(['provider', 'wallet']),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR']),
  reason: z.string(),
  paymentId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminRefund = z.infer<typeof AdminRefundSchema>;

/** GET /admin/markets/:market/orders/:order/payments */
export const AdminOrderPaymentsResponseSchema = z.object({
  order: z.object({
    id: z.uuid(),
    orderNumber: z.string(),
    status: z.string(),
    externalDueMinor: z.number().int().nonnegative(),
    currency: z.enum(['GBP', 'EUR']),
    expiresAt: z.iso.datetime(),
  }),
  attempts: z.array(AdminPaymentAttemptSchema),
  events: z.array(AdminPaymentEventSchema),
  refunds: z.array(AdminRefundSchema),
});
export type AdminOrderPaymentsResponse = z.infer<typeof AdminOrderPaymentsResponseSchema>;

/** POST /admin/markets/:market/orders/:order/payments/:payment/reconcile */
export const AdminReconcileRequestSchema = z.strictObject({ reason: ReasonSchema });
export type AdminReconcileRequest = z.infer<typeof AdminReconcileRequestSchema>;

export const AdminReconcileResponseSchema = z.object({
  /** What the check came to. Never the provider's own wording. */
  result: z.enum(['checked', 'unknown_payment', 'no_provider_reference', 'provider_unavailable']),
  /** The finalisation outcome, when the provider actually answered. */
  outcome: z.string().nullable(),
});
export type AdminReconcileResponse = z.infer<typeof AdminReconcileResponseSchema>;

/** POST /admin/markets/:market/orders/:order/payment-events/:event/payload */
export const AdminOpenPayloadRequestSchema = z.strictObject({ reason: ReasonSchema });
export type AdminOpenPayloadRequest = z.infer<typeof AdminOpenPayloadRequestSchema>;

/**
 * The opened original, returned once to the operator who asked for it.
 *
 * Never part of an ordinary payment response, never logged, and never reachable
 * from a customer route (OD-7, OD-7a, ADR-0033).
 */
export const AdminOpenPayloadResponseSchema = z.object({
  eventId: z.uuid(),
  /** Exactly the bytes the provider sent, base64 as they were sealed. */
  payloadBase64: z.string(),
});
export type AdminOpenPayloadResponse = z.infer<typeof AdminOpenPayloadResponseSchema>;

/** POST /admin/markets/:market/orders/:order/payment-events/:event/refund-duplicate */
export const AdminRefundDuplicateRequestSchema = z.strictObject({ reason: ReasonSchema });
export type AdminRefundDuplicateRequest = z.infer<typeof AdminRefundDuplicateRequestSchema>;

export const AdminRefundDuplicateResponseSchema = z.object({
  result: z.enum(['raised', 'already_raised', 'not_a_duplicate_capture']),
  refundId: z.uuid().nullable(),
});
export type AdminRefundDuplicateResponse = z.infer<typeof AdminRefundDuplicateResponseSchema>;
