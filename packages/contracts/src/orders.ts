import { z } from 'zod';
import { PaymentStatusSchema } from './payments';

/**
 * Checkout and orders (Revision 2 B7, B18 and B20; ADR-0026, ADR-0030,
 * ADR-0031).
 *
 * Phase 5 stops at an order awaiting payment. Nothing here takes a payment,
 * describes one, or says anything about tickets being sold.
 *
 * A checkout request is SELF-DESCRIBING (ADR-0032): it states the purchase the
 * customer intends to make, and the server checks that intent against the
 * basket it is actually holding for them. The request is intent, never
 * evidence — price, currency, market, availability, ownership, eligibility and
 * whether an answer is correct all come from PostgreSQL.
 */

/**
 * One line of the intended purchase (ADR-0032).
 *
 * `slug` and `quantity` follow `AddCartItemRequest`, so the checkout page
 * sends back what the basket told it. `optionId` is present exactly when the
 * draw asks a skill question.
 */
export const CheckoutItemSchema = z.object({
  /** The draw being bought, by its public slug. */
  slug: z.string().min(1).max(80),
  /** How many tickets. Checked against the reservation; never priced from. */
  quantity: z.number().int().min(1).max(10_000),
  /**
   * The option the customer picked, for a draw that asks a question. Whether
   * it is the right one is never echoed back (B20, ADR-0030).
   */
  optionId: z.uuid().optional(),
});
export type CheckoutItem = z.infer<typeof CheckoutItemSchema>;

/** POST /markets/:market/checkout/orders */
export const CreateOrderRequestSchema = z.strictObject({
  /**
   * Everything the customer means to buy. It must match the basket exactly —
   * a missing line, an extra one or a different quantity is refused, because
   * the order has to be for what they were shown (ADR-0032).
   */
  items: z.array(CheckoutItemSchema).min(1).max(50),
  /** The terms version the customer was shown, checked against the active one. */
  termsVersion: z.string().min(1).max(64),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const OrderIdParamSchema = z.object({ market: z.string(), order: z.uuid() });

export const OrderItemSchema = z.object({
  draw: z.object({ slug: z.string(), title: z.string() }),
  quantity: z.number().int().positive(),
  /** Price at the moment of purchase, not what the draw costs today. */
  unitPriceMinor: z.number().int().positive(),
  totalMinor: z.number().int().positive(),
  ticketNumbers: z.array(z.number().int().positive()),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z.object({
  id: z.uuid(),
  /** Customer-facing and opaque: `HV-` then ten base32 characters (ADR-0031). */
  orderNumber: z.string().regex(/^HV-[A-Z2-7]{10}$/),
  market: z.enum(['uk', 'ie', 'de']),
  currency: z.enum(['GBP', 'EUR']),
  /** Phase 5 only ever produces `awaiting_payment`; payment is Phase 6. */
  status: z.enum([
    'created',
    'awaiting_payment',
    'paid',
    'cancelled',
    'failed',
    'expired',
    'paid_unfulfillable',
    'partially_refunded',
    'refunded',
  ]),
  /** Whether an account or a verified guest placed it. Never an identifier. */
  placedBy: z.enum(['user', 'guest']),
  totalMinor: z.number().int().positive(),
  walletAppliedMinor: z.number().int().nonnegative(),
  externalDueMinor: z.number().int().nonnegative(),
  /** The terms the customer agreed to, as a label. */
  termsVersion: z.string(),
  items: z.array(OrderItemSchema),
  createdAt: z.iso.datetime(),
  /**
   * The payment deadline (Phase 6, D1 = B). Fixed when the order is placed and
   * never extended.
   *
   * It is always earlier than the holds behind the order expire, so a
   * countdown to it is honest: it cannot reach zero while the tickets are
   * already gone. Compare it against `serverTime`, not the browser's clock.
   */
  expiresAt: z.iso.datetime(),
  serverTime: z.iso.datetime(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderResponseSchema = z.object({ order: OrderSchema });
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const OrderListResponseSchema = z.object({ orders: z.array(OrderSchema) });
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;

/**
 * GET /checkout/order-access — presenting a return link (OD-2, D18 = B).
 *
 * ## Why the token travels in a header
 *
 * It is a bearer credential, so it cannot go in a query string: that writes it
 * into access logs, browser history and referrers. That ruled out the URL and
 * made this a POST carrying the token in a body — which was wrong for a
 * different reason. The return page is rendered by a **plain navigation**, and
 * a navigation sends no `Origin`; the API refuses every state-changing request
 * that has none, so the only caller this route has was refused before it was
 * read. A header hides the token exactly as well as a body, and leaves the
 * method free to say what this is.
 *
 * ## Why a GET is honest here
 *
 * Because the route was made genuinely read-only to earn it (S2). It resolves
 * the token, reads the order and its latest attempt, and returns them. It does
 * not reconcile, ask the provider anything, or reach finalisation — so it
 * cannot capture a payment, sell a ticket, raise a refund or send an email.
 * Confirmation reaches an order by verified webhook or by the P6-5 reconciler,
 * and never because somebody opened a link.
 */
export const ORDER_ACCESS_TOKEN_HEADER = 'x-hv-order-access';

/**
 * The token itself.
 *
 * Bounded so an absurd header never reaches the database, and *checked* rather
 * than validated-with-an-error: a malformed token is answered with the same
 * 404 as an unknown one, because separating them tells a caller which shapes
 * are worth guessing.
 */
export const OrderAccessTokenSchema = z.string().min(16).max(128);

/**
 * What a return link shows: the order, and its latest payment attempt if one
 * was ever started. Read-only — the link cannot start a payment (D18 = B).
 */
export const OrderAccessResponseSchema = z.object({
  order: OrderSchema,
  payment: PaymentStatusSchema.nullable(),
  serverTime: z.iso.datetime(),
});
export type OrderAccessResponse = z.infer<typeof OrderAccessResponseSchema>;
