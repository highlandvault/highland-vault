import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrizeArt } from '@/components/prize-art';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { checkoutErrorMessage, fetchCart } from '@/lib/checkout';
import { formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { removeFromBasket } from '../cart-actions';

export const metadata: Metadata = { title: 'Your basket', robots: { index: false } };

type Params = Promise<{ market: string }>;

/**
 * The basket (P6-8; presentation rebuilt in UI-4).
 *
 * Every line here is a **live hold on real ticket numbers**, taken through the
 * ticket engine when it was added. That is why each one shows a countdown: the
 * basket is where tickets wait, not a list of intentions, and a line whose
 * hold has run out says so rather than looking buyable.
 *
 * Nothing on this page is computed in the browser or on the web server. The
 * total, the currency, the buyable count and each line's status are the API's,
 * which is the only thing that knows what is actually held. In particular the
 * summary prints `cart.totalMinor` as given — it does not add the lines up,
 * because the lines a customer can see and the lines the API will sell are not
 * always the same set.
 *
 * **Quantity is read-only.** Adding a draw that is already in the basket is a
 * conflict by design — the API answers "remove it first to change the
 * quantity" — so there are no steppers here and no update call to make.
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
  const drawsPath = `/${market.code}/draws`;

  return (
    <div data-testid="basket">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
        <span aria-current="page">Basket</span>
      </nav>

      <header className="basket-head">
        <h1>Your basket</h1>
        <p className="basket-head__note">
          Each line below is holding real ticket numbers for you. They go back into the draw when
          the time runs out.
        </p>
      </header>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="basket-error">
          {message}
        </p>
      )}

      {items.length === 0 ? (
        <div className="empty-state">
          <h2>Your basket is empty</h2>
          <p data-testid="basket-empty">
            Nothing is being held for you at the moment. Browse the competitions in {market.name}{' '}
            and add the ones you want.
          </p>
          <Link className="button button--gold" href={drawsPath}>
            Browse competitions
          </Link>
        </div>
      ) : (
        <div className="basket">
          {/* ------------------------------------------------------- lines */}
          <ul className="basket-lines" data-testid="basket-items">
            {items.map((item) => {
              const r = item.reservation;
              const expired = r.status !== 'active';
              const drawPath = `/${market.code}/draws/${r.draw.slug}`;
              return (
                <li
                  key={item.id}
                  className={`basket-line${expired ? ' basket-line--lapsed' : ''}`}
                  data-testid="basket-item"
                >
                  <div className="basket-line__media" aria-hidden="true">
                    <PrizeArt title={r.draw.title} />
                  </div>

                  <div className="basket-line__body">
                    <div className="basket-line__head">
                      <h2 className="basket-line__title">
                        <Link href={drawPath}>{r.draw.title}</Link>
                      </h2>
                      <span className={`badge ${expired ? 'badge--closed' : 'badge--live'}`}>
                        {r.status === 'active'
                          ? 'Held'
                          : r.status === 'expired'
                            ? 'Expired'
                            : 'Released'}
                      </span>
                    </div>

                    <dl className="facts basket-line__facts">
                      <div>
                        <dt>Entries</dt>
                        <dd>{r.quantity}</dd>
                      </div>
                      <div>
                        <dt>Per entry</dt>
                        <dd>{price(r.unitPriceMinor, r.currency)}</dd>
                      </div>
                      <div>
                        <dt>Line total</dt>
                        <dd className="price" data-testid="basket-line-total">
                          {price(r.totalMinor, r.currency)}
                        </dd>
                      </div>
                    </dl>

                    {expired ? (
                      <p className="notice notice--danger" data-testid="basket-line-expired">
                        These tickets were held for too long and have gone back into the draw.
                        Nothing was charged. Remove the line, and enter again if you still want to.
                      </p>
                    ) : (
                      <ReservationCountdown expiresAt={r.expiresAt} serverTime={cart!.serverTime} />
                    )}

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
                      {expired && (
                        // A way back to the draw, and nothing more: re-entering
                        // is the customer's decision and takes a fresh hold
                        // through the ticket engine like any other.
                        <Link className="button button--quiet" href={drawPath}>
                          Back to the competition
                        </Link>
                      )}
                      <form action={removeFromBasket.bind(null, market.code, item.id)}>
                        <button type="submit" className="button button--quiet">
                          Remove
                        </button>
                      </form>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* ----------------------------------------------------- summary */}
          <aside className="basket-summary" aria-labelledby="summary-heading">
            <div className="panel">
              <h2 id="summary-heading" className="basket-summary__title">
                Summary
              </h2>

              <dl className="facts basket-summary__facts">
                <div>
                  <dt>Ready to buy</dt>
                  <dd>
                    {cart!.activeItemCount}{' '}
                    {cart!.activeItemCount === 1 ? 'competition' : 'competitions'}
                  </dd>
                </div>
                {cart!.currency && (
                  <div>
                    <dt>Currency</dt>
                    <dd>{cart!.currency}</dd>
                  </div>
                )}
              </dl>

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
                  Only the lines still holding tickets can be bought.{' '}
                  {lapsed.length === 1 ? 'One line has' : `${lapsed.length} lines have`} expired and
                  {lapsed.length === 1 ? ' is' : ' are'} not included in this total.
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
                <button
                  type="button"
                  className="button button--gold button--block"
                  disabled
                  data-testid="basket-checkout"
                >
                  Nothing left to buy
                </button>
              )}

              <Link className="link-arrow basket-summary__back" href={drawsPath}>
                Keep browsing <span aria-hidden="true">→</span>
              </Link>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
