import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { fetchOrders } from '@/lib/checkout';
import { formatDateTime, formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false } };

type Params = Promise<{ market: string }>;

/**
 * Every order this customer has placed in this market (UI-8).
 *
 * **Market-scoped, because the API is.** `GET /markets/{market}/checkout/orders`
 * answers for one market and decides whose orders those are from the session it
 * was sent; this page asks that one question and prints the answer. There is no
 * account-wide list and nothing here fans out across markets — the market bar
 * above is how a customer moves between them.
 *
 * Nothing on this page is computed here. The order of the list, the statuses,
 * the totals and the fifty it stops at are all the API's. In particular no
 * total is added up locally: an order's `totalMinor` is what was charged for
 * it, and recomputing it from the lines would invent a second answer.
 *
 * ## Empty is not the same as unavailable
 *
 * "You have not ordered anything yet" is a claim about the customer, and it is
 * only safe to make when the API said so. A call that failed gets a refusal to
 * display instead, because a page that renders its empty state on an error
 * tells people their orders are gone.
 *
 * ## The deadline, not just the status
 *
 * An order says `awaiting_payment` for up to a minute after its deadline has
 * passed, since it is the worker's sweep that records the expiry and not
 * anyone reading the row. So payability is derived the same way the order page
 * derives it — status AND the API's own clock — and a lapsed order is shown as
 * expired rather than invited to be paid for.
 */
export default async function OrdersPage({ params }: { params: Params }) {
  const { market: code } = await params;
  const market = await fetchMarket(code);
  if (!market) notFound();

  const path = `/${market.code}/orders`;
  const lookup = await fetchOrders(market.code);
  // The list route recognises a caller rather than requiring one, so being
  // signed out arrives here as a lookup failure. Sign in and come back.
  if (!lookup.ok && lookup.reason === 'signed_out') {
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  const when = (iso: string) => formatDateTime(iso, market.locale, market.code);

  return (
    <div data-testid="orders">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> &rsaquo;{' '}
        <span aria-current="page">Orders</span>
      </nav>

      <header className="basket-head">
        <h1>Your orders</h1>
        <p className="basket-head__note">
          Everything you have bought in {market.name}, newest first. Open an order to see its ticket
          numbers.
        </p>
      </header>

      {!lookup.ok ? (
        <p className="notice notice--danger" role="alert" data-testid="orders-unavailable">
          We could not load your orders just now. Try again in a moment.
        </p>
      ) : lookup.orders.length === 0 ? (
        <div className="empty-state">
          <h2>No orders yet</h2>
          <p data-testid="orders-empty">
            You have not bought anything in {market.name} yet. Anything you buy will appear here
            with its ticket numbers.
          </p>
          <Link className="button button--gold" href={`/${market.code}/draws`}>
            Browse competitions
          </Link>
        </div>
      ) : (
        <ul className="payment-lines" data-testid="order-list">
          {lookup.orders.map((order) => {
            const payable =
              order.status === 'awaiting_payment' &&
              Date.parse(order.expiresAt) > Date.parse(order.serverTime);
            // The same derived state the order page uses: the status has not
            // caught up with the clock yet, and this one is not payable.
            const deadlinePassed = order.status === 'awaiting_payment' && !payable;
            const state = deadlinePassed
              ? ORDER_BADGES.deadline_passed!
              : (ORDER_BADGES[order.status] ?? ORDER_BADGES.default!);
            const entries = order.items.reduce((n, item) => n + item.quantity, 0);
            return (
              <li className="order-row" key={order.id} data-testid="order-row">
                <div className="order-row__head">
                  <h2 className="payment-line__title">
                    <Link href={`${path}/${order.id}`} data-testid="order-row-link">
                      Order {order.orderNumber}
                    </Link>
                  </h2>
                  <span className={`badge badge--${state.badge}`} data-testid="order-row-status">
                    {state.label}
                  </span>
                </div>

                <p className="hint" data-testid="order-row-draws">
                  {order.items.map((item) => item.draw.title).join(', ')}
                </p>

                <dl className="facts">
                  <div>
                    <dt>Placed</dt>
                    <dd>
                      <time dateTime={order.createdAt}>{when(order.createdAt)}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>Entries</dt>
                    <dd>{entries}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd className="price" data-testid="order-row-total">
                      {formatPrice(order.totalMinor, order.currency, market.locale)}
                    </dd>
                  </div>
                </dl>

                {payable && (
                  <p className="hint" data-testid="order-row-deadline">
                    Still to pay — your tickets are held until {when(order.expiresAt)}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One word for each status, and an existing badge tone to carry it.
 *
 * Written out here rather than shared with the order page: each page says as
 * much as it has room for, and the order page's map also holds a full sentence
 * and a payment-panel aside that a list row has no use for. That is the pattern
 * the return page follows too.
 *
 * `label` is the state in words, so nothing depends on the colour. There is no
 * entry for `failed` — nothing in the system moves an order to it (owner
 * decision K-c is open) — so it falls to the generic, like any status this
 * build has not been told about.
 */
const ORDER_BADGES: Record<string, { badge: string; label: string }> = {
  awaiting_payment: { badge: 'scheduled', label: 'Awaiting payment' },
  paid: { badge: 'live', label: 'Paid' },
  paid_unfulfillable: { badge: 'cancelled', label: 'Refund started' },
  expired: { badge: 'cancelled', label: 'Expired' },
  // Derived, not a status the API returns: the minute between a deadline
  // passing and the sweep recording it.
  deadline_passed: { badge: 'cancelled', label: 'Expired' },
  cancelled: { badge: 'cancelled', label: 'Cancelled' },
  refunded: { badge: 'closed', label: 'Refunded' },
  partially_refunded: { badge: 'closed', label: 'Partly refunded' },
  default: { badge: 'draft', label: 'In progress' },
};
