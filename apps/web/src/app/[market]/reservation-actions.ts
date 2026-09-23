'use server';

import { ReservationResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { RESERVATION_ID } from '@/lib/reservations';

/**
 * Reservation actions. They only forward the customer's choice to the API,
 * which decides everything: availability, the per-person cap, the price and
 * the expiry. The browser never sees the session token or talks to the API.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function reserveTickets(market: string, slug: string, form: FormData): Promise<void> {
  if (!isMarketCode(market) || !SLUG.test(slug) || slug.length > 80) redirect('/');
  const drawPath = `/${market}/draws/${slug}`;
  const quantity = Number(form.get('quantity'));
  const result = await apiFetch(`/markets/${market}/draws/${slug}/reservations`, {
    method: 'POST',
    body: { quantity },
    parse: (json) => ReservationResponseSchema.parse(json).reservation,
  });
  if (!result.ok) {
    if (result.status === 401 || result.code === 'MFA_REQUIRED') {
      redirect(`/login?next=${encodeURIComponent(drawPath)}`);
    }
    redirect(`${drawPath}?error=${result.code}#entry`);
  }
  redirect(`/${market}/reservations/${result.data.id}`);
}

export async function releaseReservation(market: string, id: string): Promise<void> {
  if (!isMarketCode(market) || !RESERVATION_ID.test(id)) redirect('/');
  const path = `/${market}/reservations/${id}`;
  const result = await apiFetch(`/markets/${market}/reservations/${id}/release`, {
    method: 'POST',
    body: {},
  });
  if (!result.ok && result.status === 401) redirect(`/login?next=${encodeURIComponent(path)}`);
  redirect(result.ok ? path : `${path}?error=${result.code}`);
}
