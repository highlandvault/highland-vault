import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { checkoutErrorMessage, fetchCart } from '@/lib/checkout';
import { formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { removeFromBasket } from '../cart-actions';

export const metadata: Metadata = { title: 'Your basket', robots: { index: false } };

type Params = Promise<{ market: string }>;

/**
 * The basket (P6-8).
 *
 * Every line here is a **live hold on real ticket numbers**, taken through the
 * ticket engine when it was added. That is why each one shows a countdown: the
 * basket is where tickets wait, not a list of intentions, and a line whose
 * hold has run out says so rather than looking buyable.
 *
 * Nothing on this page is computed in the browser or on the web server. The
 * total, the currency and each line's status are the API's, which is the only
 * thing that knows what is actually held.
 */
export default async function BasketPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ error?: string }>;
}) {
  const { market: code } = await params;
  const { error } = await searchParams;
  const market = await fetchMarket(code);
  if (!market) notFound();

  const cart = await fetchCart(market.code);
  const message = checkoutErrorMessage(error);
  const items = cart?.items ?? [];
  const live = items.filter((item) => item.reservation.status === 'active');
  const lapsed = items.filter((item) => item.reservation.status !== 'active');
  const price = (minor: number, currency: 'GBP' | 'EUR') =>
    formatPrice(minor, currency, market.locale);

  return (
    <main className="page" data-testid="basket">
      <h1>Your basket</h1>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="basket-error">
          {message}
        </p>
      )}

      {items.length === 0 ? (
        <div className="panel">
          <p data-testid="basket-empty">Your basket is empty.</p>
          <Link className="button button--gold" href={`/${market.code}/draws`}>
            Browse draws
          </Link>
        </div>
      ) : (
        <>
          <ul className="basket-lines" data-testid="basket-items">
            {items.map((item) => {
              const r = item.reservation;
              const expired = r.status !== 'active';
              return (
                <li key={item.id} className="panel" data-testid="basket-item">
                  <div>
                    <h2>
                      <Link href={`/${market.code}/draws/${r.draw.slug}`}>{r.draw.title}</Link>
                    </h2>
                    <p>
                      {r.quantity} {r.quantity === 1 ? 'entry' : 'entries'} ·{' '}
                      <strong data-testid="basket-line-total">
                        {price(r.totalMinor, r.currency)}
                      </strong>
                    </p>
                    {expired ? (
                      <p className="notice notice--danger" data-testid="basket-line-expired">
                        These tickets were held for too long and have been released. Remove the line
                        and choose again.
                      </p>
                    ) : (
                      <ReservationCountdown expiresAt={r.expiresAt} serverTime={cart!.serverTime} />
                    )}
                  </div>
                  <div className="basket-line-actions">
                    {/*
                      The hold is a real reservation with real ticket numbers,
                      and its own page still shows them. Keeping the link means
                      the basket does not hide what the customer is holding.
                    */}
                    <Link
                      className="button button--quiet"
                      href={`/${market.code}/reservations/${r.id}`}
                      data-testid="basket-line-tickets"
                    >
                      View tickets
                    </Link>
                    <form action={removeFromBasket.bind(null, market.code, item.id)}>
                      <button type="submit" className="button button--quiet">
                        Remove
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="panel">
            <p className="total">
              <span>Total</span>
              <span className="price" data-testid="basket-total">
                {cart!.totalMinor !== null && cart!.currency
                  ? price(cart!.totalMinor, cart!.currency)
                  : '—'}
              </span>
            </p>
            {lapsed.length > 0 && (
              <p className="hint" data-testid="basket-lapsed-note">
                Only the lines still holding tickets can be bought.
              </p>
            )}
            {live.length > 0 ? (
              <Link
                className="button button--gold button--block"
                href={`/${market.code}/checkout`}
                data-testid="basket-checkout"
              >
                Continue to checkout
              </Link>
            ) : (
              <button type="button" className="button button--gold button--block" disabled>
                Nothing left to buy
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
