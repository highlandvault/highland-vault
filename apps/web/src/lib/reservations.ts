import 'server-only';
import {
  type AvailabilityResponse,
  AvailabilityResponseSchema,
  type Reservation,
  ReservationResponseSchema,
} from '@hv/contracts';
import { apiFetch } from './api';

/**
 * Ticket data for the customer pages, always from the API: it applies the
 * market gate and ownership, so nothing here can show another market's draw
 * or another customer's reservation.
 */

export const RESERVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Display-only availability (and, when signed in, the caller's remaining allowance). */
export async function fetchAvailability(
  market: string,
  slug: string,
): Promise<AvailabilityResponse | null> {
  const result = await apiFetch(`/markets/${market}/draws/${slug}/availability`, {
    parse: (json) => AvailabilityResponseSchema.parse(json),
  });
  return result.ok ? result.data : null;
}

export type ReservationLookup =
  { ok: true; reservation: Reservation } | { ok: false; reason: 'not_found' | 'signed_out' };

/** The caller's own reservation. Anything they do not own is simply not found. */
export async function fetchReservation(market: string, id: string): Promise<ReservationLookup> {
  if (!RESERVATION_ID.test(id)) return { ok: false, reason: 'not_found' };
  const result = await apiFetch(`/markets/${market}/reservations/${id}`, {
    parse: (json) => ReservationResponseSchema.parse(json).reservation,
  });
  if (result.ok) return { ok: true, reservation: result.data };
  if (result.status === 401) return { ok: false, reason: 'signed_out' };
  if (result.status === 404) return { ok: false, reason: 'not_found' };
  throw new Error(`Reservation lookup failed: ${result.code}`);
}

const ENTRY_MESSAGES: Record<string, string> = {
  INSUFFICIENT_TICKETS:
    'There are not enough tickets left for that many entries. Choose fewer and try again.',
  TICKET_CAP_EXCEEDED: 'That would take you over the per-person entry limit for this draw.',
  DRAW_NOT_OPEN: 'This draw is not open for entries.',
  INVALID_QUANTITY: 'Choose a number of entries within the per-person limit.',
  VALIDATION_FAILED: 'Choose a number of entries within the per-person limit.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  ORIGIN_NOT_ALLOWED: 'This request was refused (origin not allowed).',
  UNREACHABLE: 'The service is unavailable. Try again shortly.',
};

export function entryErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return ENTRY_MESSAGES[code] ?? 'Something went wrong. Try again.';
}
