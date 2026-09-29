import { z } from 'zod';

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
