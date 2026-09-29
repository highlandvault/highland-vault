/**
 * Handlers for the four order-outcome topics (Phase 6, task P6-5; owner
 * decisions D16 = C, D16a, D16b, and K-4).
 *
 * ## Why these exist before there is anything to send
 *
 * `createTopicDispatcher` **fails** an event whose topic has no handler, rather
 * than dropping it (ADR-0028). That is deliberate and right: a forgotten
 * registration becomes a visible stuck queue instead of silent data loss. But
 * it also means P6-4 has been writing `order.paid` and `order.unfulfillable`
 * rows that no handler would accept, and every one of them has been failing and
 * backing off since that slice merged. Registering all four closes that.
 *
 * ## What they deliberately do not do
 *
 * **They send no customer message.** OD-6 puts notification content in P12 and
 * says explicitly that no final email copy is written in Phase 6. Inventing
 * wording here would be inventing product, and wording that reaches a customer
 * who has just been charged is the last thing to guess at. So Phase 6 registers
 * the handlers and P12 replaces their bodies with a real relay — the same
 * two-phase seam §20 describes.
 *
 * Marking the row published is honest about what happened: the event was
 * accepted and handled by the half of the system that exists. It is not a claim
 * that an email was sent, and nothing in the schema says it is —
 * `published_at` on a verification email means SMTP accepted it because THAT
 * handler defers to the notifications queue and that queue sets it.
 *
 * ## `order.payment_failed`
 *
 * Registered, and **nothing emits it**. What makes an ORDER failed is K-c and
 * remains an open owner decision: under D3 = B a customer whose attempt failed
 * may start another while their deadline holds, so a failed attempt is not a
 * failed order. The handler is here because G4.11 requires every Phase 6 topic
 * to have one, not because anything writes it.
 */
import { ORDER_OUTCOME_TOPICS } from '@hv/domain';
import type { OutboxEvent, OutboxHandler, OutboxOutcome } from './outbox';

export interface OrderOutcomeLog {
  log(message: string): void;
}

/**
 * Handles one order-outcome event.
 *
 * Idempotent, because it must be: the claim lease can bring an event back and
 * the same row can be handled twice (ADR-0028). Doing nothing twice is the same
 * as doing it once, which is the easiest way to satisfy that and the honest
 * shape of the Phase 6 half.
 *
 * The payload carries an order id and number and nothing else — no address, no
 * ticket numbers, no provider reference — so this may be logged as it stands.
 */
export function createOrderOutcomeHandler(logger?: OrderOutcomeLog): OutboxHandler {
  return (event: OutboxEvent): Promise<OutboxOutcome> => {
    const orderNumber = event.payload.orderNumber;
    logger?.log(
      `order outcome ${event.topic} for ${typeof orderNumber === 'string' ? orderNumber : 'an order'}`,
    );
    return Promise.resolve('published');
  };
}

/** All four topics, mapped to the handler. Registered as one, so none is missed. */
export function orderOutcomeHandlers(
  logger?: OrderOutcomeLog,
): Readonly<Record<string, OutboxHandler>> {
  const handler = createOrderOutcomeHandler(logger);
  return Object.fromEntries(ORDER_OUTCOME_TOPICS.map((topic) => [topic, handler]));
}
