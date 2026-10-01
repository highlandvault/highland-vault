/**
 * The outbox topics an order's outcome is announced on (Phase 6, owner
 * decisions D16 = C, D16a and D16b).
 *
 * All four sit under `order.*` and there are no aliases. Each states an
 * outcome **of the order**, which is the thing being settled; a payment
 * attempt is a means to that outcome and never the subject of a customer
 * notification.
 *
 * The names live here, one slice before anything emits them, because a topic
 * name is written into every outbox row and into the worker's dispatcher. An
 * unregistered topic fails its event by design rather than dropping it
 * (ADR-0028), so a name that drifts between the writer and the handler is a
 * stuck queue, not a lost message — and defining them once is what stops that.
 *
 * P6-3 emits none of these. It stores provider events and settles the ones
 * that need nothing further; moving an order, and announcing that it moved, is
 * finalisation's job (P6-4).
 *
 * Note what is absent: any refund-completion topic. Nothing in Phase 6
 * completes a refund, so nothing in Phase 6 may emit one — P10 names it when
 * it builds the consumer (D16a).
 */

/** An order is paid and its tickets are sold. */
export const ORDER_PAID_TOPIC = 'order.paid';
/** An attempt failed definitively and no other is live. The order may still be payable. */
export const ORDER_PAYMENT_FAILED_TOPIC = 'order.payment_failed';
/** The payment deadline passed with nothing succeeded. */
export const ORDER_EXPIRED_TOPIC = 'order.expired';
/**
 * The customer paid, and the tickets can no longer be delivered.
 *
 * It may say a refund has been **initiated** — never that one has completed,
 * which is not true at the moment this is written and is P10's to announce
 * (D16a).
 */
export const ORDER_UNFULFILLABLE_TOPIC = 'order.unfulfillable';

/** Every topic Phase 6 may write. Anything else is a mistake, not a new feature. */
export const ORDER_OUTCOME_TOPICS = Object.freeze([
  ORDER_PAID_TOPIC,
  ORDER_PAYMENT_FAILED_TOPIC,
  ORDER_EXPIRED_TOPIC,
  ORDER_UNFULFILLABLE_TOPIC,
] as const);

export type OrderOutcomeTopic = (typeof ORDER_OUTCOME_TOPICS)[number];
