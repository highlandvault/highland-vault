/**
 * Ticket engine rules (ADR-0008 cap identity, ADR-0011 reservations,
 * ADR-0027 sequential numbers). The database is the final authority
 * (migration 0009); these pure functions give the API the same answers first.
 */
import { effectiveStatus, type DrawTiming } from './draws';
import { normalizeEmail } from './email';

/** D11: checkout reserves tickets for 10 minutes. */
export const RESERVATION_TTL_SECONDS = 600;

export const TICKET_STATUSES = ['available', 'reserved', 'sold'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * available → reserved → sold, and reserved → available on expiry or release.
 * Nothing leaves "sold" here (refunds are a later phase, O7).
 */
export function canTicketTransition(from: TicketStatus, to: TicketStatus): boolean {
  return (
    (from === 'available' && to === 'reserved') ||
    (from === 'reserved' && (to === 'available' || to === 'sold'))
  );
}

/**
 * Who a cap applies to (ADR-0008). A signed-in customer is keyed by user id;
 * a guest by normalized VERIFIED email — verification arrives with checkout in
 * Phase 5 (ADR-0020), so only the service that verified the email may build one.
 * No device, card or address fingerprinting.
 */
export type Entrant =
  | { readonly type: 'user'; readonly userId: string }
  | { readonly type: 'email'; readonly verifiedEmail: string };

export function entrantKey(entrant: Entrant): { type: 'user' | 'email'; ref: string } {
  return entrant.type === 'user'
    ? { type: 'user', ref: entrant.userId }
    : { type: 'email', ref: normalizeEmail(entrant.verifiedEmail) };
}

export type ReservationRefusal =
  'draw_not_open' | 'invalid_quantity' | 'cap_exceeded' | 'insufficient_tickets';

export class ReservationRefused extends Error {
  override readonly name = 'ReservationRefused';

  constructor(
    readonly reason: ReservationRefusal,
    message: string,
    readonly details: Readonly<Record<string, number>> = {},
  ) {
    super(message);
  }
}

/** Only an open draw takes entries: published, opening time reached, not closed. */
export function isOpenForEntries(draw: DrawTiming, now: Date): boolean {
  return effectiveStatus(draw, now) === 'live';
}

/** A whole number of tickets, at least 1 and at most the per-person cap. */
export function isValidQuantity(quantity: number, maxPerPerson: number): boolean {
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maxPerPerson;
}

/** Tickets the entrant may still take in this draw. */
export function remainingAllowance(held: number, maxPerPerson: number): number {
  return Math.max(0, maxPerPerson - held);
}

/** Exact total in integer minor units. Throws rather than lose precision. */
export function reservationTotal(unitPriceMinor: number, quantity: number): number {
  const total = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(total)) throw new RangeError('reservation total out of range');
  return total;
}

export type ReservationStatus = 'active' | 'released' | 'expired';

/** An active reservation past its expiry is expired, even before the sweeper has run. */
export function effectiveReservationStatus(
  status: ReservationStatus,
  expiresAt: Date,
  now: Date,
): ReservationStatus {
  return status === 'active' && expiresAt <= now ? 'expired' : status;
}

/** Display form, zero-padded to the width of the draw's largest number: 21 of 50000 → "00021". */
export function formatTicketNumber(ticketNumber: number, totalTickets: number): string {
  return String(ticketNumber).padStart(String(totalTickets).length, '0');
}
