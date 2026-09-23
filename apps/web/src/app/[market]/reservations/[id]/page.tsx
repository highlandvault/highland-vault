import { formatTicketNumber } from '@hv/domain';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { formatDateTime, formatPrice } from '@/lib/format';
import { entryErrorMessage, fetchReservation } from '@/lib/reservations';
import { fetchMarket } from '@/markets';
import { releaseReservation } from '../../reservation-actions';

export const metadata: Metadata = { title: 'Your reservation', robots: { index: false } };

type Params = Promise<{ market: string; id: string }>;

/**
 * The customer's reservation: the real ticket numbers, the exact total and
 * the time left, all as the API reports them. Refreshing, reopening or waking
 * the device always shows the server's current state.
 */
export default async function ReservationPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ error?: string }>;
}) {
  const { market: code, id } = await params;
  const { error } = await searchParams;
  const market = await fetchMarket(code);
  if (!market) notFound();
  const path = `/${market.code}/reservations/${id}`;
  const lookup = await fetchReservation(market.code, id);
  if (!lookup.ok) {
    if (lookup.reason === 'signed_out') redirect(`/login?next=${encodeURIComponent(path)}`);
    notFound();
  }
  const r = lookup.reservation;
  const drawPath = `/${market.code}/draws/${r.draw.slug}`;
  const price = (minor: number) => formatPrice(minor, r.currency, market.locale);
  const message = entryErrorMessage(error);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
        <Link href={drawPath}>{r.draw.title}</Link> › Reservation
      </nav>

      <div className="reservation" data-testid="reservation" data-status={r.status}>
        <section className="panel stack" aria-labelledby="reservation-title">
          {r.status === 'active' ? (
            <>
              <div>
                <p className="eyebrow">Reserved</p>
                <h1 id="reservation-title" data-testid="reservation-title">
                  Your tickets are reserved
                </h1>
                <p className="hint">
                  {r.draw.title} · held until{' '}
                  <time dateTime={r.expiresAt}>
                    {formatDateTime(r.expiresAt, market.locale, market.code)}
                  </time>
                </p>
              </div>
              <ReservationCountdown expiresAt={r.expiresAt} serverTime={r.serverTime} />
            </>
          ) : (
            <div>
              <p className="eyebrow">{r.status === 'expired' ? 'Expired' : 'Released'}</p>
              <h1 id="reservation-title" data-testid="reservation-title">
                {r.status === 'expired'
                  ? 'This reservation has expired'
                  : 'You released this reservation'}
              </h1>
              <p>
                {r.status === 'expired'
                  ? 'The time ran out, so the tickets went back into the draw for others. Nothing was charged.'
                  : 'The tickets went back into the draw for others. Nothing was charged.'}
              </p>
            </div>
          )}

          {message && (
            <p className="notice notice--danger" role="alert">
              {message}
            </p>
          )}

          {r.status === 'active' && (
            <div>
              <h2 className="label">
                Your ticket {r.ticketNumbers.length === 1 ? 'number' : 'numbers'}
              </h2>
              <ul className="ticket-numbers" data-testid="ticket-numbers">
                {r.ticketNumbers.map((n) => (
                  <li key={n} className="ticket" data-testid="ticket-number">
                    #{formatTicketNumber(n, r.draw.totalTickets)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="facts">
            <div>
              <dt>Entries</dt>
              <dd data-testid="reservation-quantity">{r.quantity}</dd>
            </div>
            <div>
              <dt>Price per entry</dt>
              <dd>{price(r.unitPriceMinor)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className="price" data-testid="reservation-total">
                {price(r.totalMinor)}
              </dd>
            </div>
          </dl>

          {r.status === 'active' ? (
            <div className="stack">
              <button
                type="button"
                className="button button--gold button--block"
                disabled
                aria-describedby="continue-note"
              >
                Continue
              </button>
              <p className="notice" id="continue-note" data-testid="checkout-unavailable">
                Checkout is not available yet, so nothing can be paid for. Your tickets stay
                reserved until the timer ends, then return to the draw.
              </p>
              <form action={releaseReservation.bind(null, market.code, r.id)}>
                <button type="submit" className="button button--outline button--block">
                  Release these tickets
                </button>
              </form>
            </div>
          ) : (
            <Link className="button button--gold button--block" href={drawPath}>
              Back to the draw
            </Link>
          )}
        </section>
      </div>
    </>
  );
}
