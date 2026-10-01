import 'server-only';
import { PaymentStatusResponseSchema, type PaymentStatus } from '@hv/contracts';
import { apiFetch } from './api';

/**
 * Where a payment attempt stands (UI-6).
 *
 * One function, wrapping one read. The route behind it is read-only by
 * construction (ADR-0035): it answers from the database and cannot reconcile,
 * cannot reach finalisation, and cannot ask the provider anything. Nothing on
 * this side could make it do otherwise, which is the point — the only things
 * that may resolve a payment are a verified webhook and the reconciler, and
 * neither of them is a browser.
 *
 * It reports the ORDER's status alongside the attempt's, and that is the field
 * customer-facing wording is keyed on. An attempt the provider calls
 * `succeeded` has delivered nothing until the order says `paid`.
 */
export async function fetchPaymentStatus(
  market: string,
  orderId: string,
  paymentId: string,
): Promise<PaymentStatus | null> {
  const result = await apiFetch(
    `/markets/${market}/checkout/orders/${orderId}/payments/${paymentId}`,
    { parse: (json) => PaymentStatusResponseSchema.parse(json).payment },
  );
  // Somebody else's attempt, a lapsed guest verification, a rate limit: all the
  // same answer here, because none of them is a state the caller may act on.
  return result.ok ? result.data : null;
}
