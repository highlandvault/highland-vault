import { z } from 'zod';
import { ReservationSchema } from './tickets';

/**
 * The server-side basket (Revision 2 B4, ADR-0026, ADR-0031).
 *
 * One basket per market, owned by a signed-in customer or a guest session. The
 * client is never the source of truth for price, currency, market,
 * availability or eligibility: everything below is produced by the API from
 * what is in PostgreSQL, and a request only ever says which draw and how many.
 */

/** POST /markets/:market/cart/items */
export const AddCartItemRequestSchema = z.strictObject({
  /** The draw to add, by its public slug. Quantity is checked against the draw's limit. */
  slug: z.string().min(1).max(80),
  quantity: z.number().int().min(1).max(10_000),
});
export type AddCartItemRequest = z.infer<typeof AddCartItemRequestSchema>;

export const CartItemIdParamSchema = z.object({ market: z.string(), item: z.uuid() });

/**
 * One draw in the basket, and the reservation holding its tickets.
 *
 * The reservation carries the money and the expiry, and is reported with its
 * effective status, so an item whose hold has run out says so rather than
 * looking live.
 */
export const CartItemSchema = z.object({
  id: z.uuid(),
  addedAt: z.iso.datetime(),
  reservation: ReservationSchema,
});
export type CartItem = z.infer<typeof CartItemSchema>;

export const CartSchema = z.object({
  /** Null until the caller has something in the basket; no row is created to look at one. */
  id: z.uuid().nullable(),
  market: z.enum(['uk', 'ie', 'de']),
  /** Whose basket this is. A guest's is tied to their guest session, not their address. */
  owner: z.enum(['user', 'guest']).nullable(),
  items: z.array(CartItemSchema),
  /** Items whose reservation is still active — the only ones that can become an order. */
  activeItemCount: z.number().int().nonnegative(),
  /**
   * Total for the active items only, in integer minor units of `currency`.
   * Null when nothing is active, because a total needs a currency to mean anything.
   */
  totalMinor: z.number().int().nonnegative().nullable(),
  currency: z.enum(['GBP', 'EUR']).nullable(),
  serverTime: z.iso.datetime(),
});
export type Cart = z.infer<typeof CartSchema>;

export const CartResponseSchema = z.object({ cart: CartSchema });
export type CartResponse = z.infer<typeof CartResponseSchema>;
