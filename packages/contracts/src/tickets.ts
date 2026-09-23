import { z } from 'zod';

/** POST /markets/:market/draws/:slug/reservations */
export const CreateReservationRequestSchema = z.strictObject({
  quantity: z.number().int().min(1).max(10_000),
});
export type CreateReservationRequest = z.infer<typeof CreateReservationRequestSchema>;

export const ReservationIdParamSchema = z.object({ market: z.string(), reservation: z.uuid() });

/**
 * A reservation as its owner sees it. Ticket numbers are the customer-facing
 * identity of tickets; internal ids never leave the API.
 */
export const ReservationSchema = z.object({
  id: z.uuid(),
  market: z.enum(['uk', 'ie', 'de']),
  draw: z.object({ slug: z.string(), title: z.string(), totalTickets: z.number().int() }),
  /** Effective status: an active reservation past its expiry is reported as expired. */
  status: z.enum(['active', 'released', 'expired']),
  quantity: z.number().int().positive(),
  /** Sequential numbers held while active (ADR-0027); empty once released or expired. */
  ticketNumbers: z.array(z.number().int().positive()),
  currency: z.enum(['GBP', 'EUR']),
  unitPriceMinor: z.number().int().positive(),
  /** Authoritative total: unitPriceMinor × quantity, integer minor units. */
  totalMinor: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** Server clock when the response was produced, so countdowns can correct for clock skew. */
  serverTime: z.iso.datetime(),
});
export type Reservation = z.infer<typeof ReservationSchema>;

export const ReservationResponseSchema = z.object({ reservation: ReservationSchema });
export type ReservationResponse = z.infer<typeof ReservationResponseSchema>;

/** GET /markets/:market/reservations — the caller's own active reservations in this market. */
export const ReservationListResponseSchema = z.object({ reservations: z.array(ReservationSchema) });
export type ReservationListResponse = z.infer<typeof ReservationListResponseSchema>;

/**
 * GET /markets/:market/draws/:slug/availability — display only, cached for a
 * few seconds (Revision 2 B9); never used for decisions.
 */
export const AvailabilityResponseSchema = z.object({
  available: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  /** How many more tickets the signed-in caller may take (null when signed out). */
  allowance: z.number().int().nonnegative().nullable(),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;

/** GET /admin/markets/:market/draws/:draw/inventory */
export const InventoryResponseSchema = z.object({
  inventory: z.object({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    sold: z.number().int().nonnegative(),
    reservations: z.object({
      active: z.number().int().nonnegative(),
      released: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
  }),
});
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;
