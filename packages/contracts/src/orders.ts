import { z } from 'zod';

/**
 * Checkout and orders (Revision 2 B7, B18 and B20; ADR-0026, ADR-0030,
 * ADR-0031).
 *
 * Phase 5 stops at an order awaiting payment. Nothing here takes a payment,
 * describes one, or says anything about tickets being sold.
 *
 * The request says which skill answer was chosen and nothing else that costs
 * money: the market, the draws, the quantities, the prices and the terms all
 * come from what is already in PostgreSQL.
 */

export const SkillAnswerSchema = z.object({
  /** The draw being answered for, by its public slug. */
  slug: z.string().min(1).max(80),
  /** The option the customer picked. Whether it is right is never echoed back. */
  optionId: z.uuid(),
});
export type SkillAnswer = z.infer<typeof SkillAnswerSchema>;

/** POST /markets/:market/checkout/orders */
export const CreateOrderRequestSchema = z.strictObject({
  /**
   * One answer per draw in the basket that asks a question. Order does not
   * matter; a missing or extra answer is refused.
   */
  answers: z.array(SkillAnswerSchema).min(1).max(50),
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
  serverTime: z.iso.datetime(),
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderResponseSchema = z.object({ order: OrderSchema });
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const OrderListResponseSchema = z.object({ orders: z.array(OrderSchema) });
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;
