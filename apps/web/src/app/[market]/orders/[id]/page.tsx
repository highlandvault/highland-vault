import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { checkoutErrorMessage, fetchOrder } from '@/lib/checkout';
import { formatDateTime, formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { startPayment } from '../../checkout-actions';

export const metadata: Metadata = { title: 'Your order', robots: { index: false } };

type Params = Promise<{ market: string; id: string }>;

/**
 * The order, and where its payment stands (P6-8, §19).
 *
 * The status shown is **the order's**, read from the API. A payment attempt
 * the provider calls succeeded has delivered nothing until the order says
 * `paid`, and nothing a browser does — arriving, refreshing, or carrying any
 * query string it likes — can move it. Confirmation reaches the order through
 * a verified webhook or a trusted server-side status check, and through
 * nothing else.
 *
 * The countdown runs to the order's own payment deadline. That is honest: the
 * deadline is set 90 seconds before the earliest hold expires (D1 = B), so it
 * can never reach zero while the tickets are already gone.
 */
export default async function OrderPage({
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

  const path = `/${market.code}/orders/${id}`;
  const lookup = await fetchOrder(market.code, id);
  if (!lookup.ok) {
    if (lookup.reason === 'signed_out') redirect(`/login?next=${encodeURIComponent(path)}`);
    notFound();
  }
  const order = lookup.order;
  const price = (minor: number) => formatPrice(minor, order.currency, market.locale);
  const message = checkoutErrorMessage(error);
  const state = ORDER_STATES[order.status] ?? ORDER_STATES.default!;

  return (
    <div data-testid="order">
      <h1>Order {order.orderNumber}</h1>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="order-error">
          {message}
        </p>
      )}

      <p className={`notice notice--${state.tone}`} data-testid="order-status">
        {state.message}
      </p>

      <section className="panel">
        <h2>What you bought</h2>
        <ul data-testid="order-items">
          {order.items.map((item) => (
            <li key={item.draw.slug}>
              <strong>{item.draw.title}</strong> — {item.quantity}{' '}
              {item.quantity === 1 ? 'entry' : 'entries'} · {price(item.totalMinor)}
            </li>
          ))}
        </ul>
        <p className="total">
          <span>Total</span>
          <span className="price" data-testid="order-total">
            {price(order.totalMinor)}
          </span>
        </p>
        <p className="hint">
          Placed {formatDateTime(order.createdAt, market.locale, market.code)}.
        </p>
      </section>

      {order.status === 'awaiting_payment' && (
        <section className="panel">
          <h2>Pay for your order</h2>
          <p data-testid="order-deadline">
            Pay by {formatDateTime(order.expiresAt, market.locale, market.code)}.
          </p>
          <ReservationCountdown expiresAt={order.expiresAt} serverTime={order.serverTime} />
          <form action={startPayment.bind(null, market.code, order.id)}>
            <button
              type="submit"
              className="button button--gold button--block"
              data-testid="order-pay"
            >
              Pay now
            </button>
          </form>
          <p className="hint">
            You will be taken to our payment provider and brought back here afterwards.
          </p>
        </section>
      )}

      <Link className="button button--quiet" href={`/${market.code}/draws`}>
        Browse more draws
      </Link>
    </div>
  );
}

/**
 * What each order status means to the customer (§19).
 *
 * `paid_unfulfillable` states plainly that a refund has been **raised**, never
 * that one has completed — at the moment the order reaches that state the
 * refund record exists and no money has moved, and saying otherwise would be
 * false every time (D16a).
 */
const ORDER_STATES: Record<string, { tone: string; message: string }> = {
  awaiting_payment: {
    tone: 'info',
    message: 'Your tickets are held. Pay before the time runs out to keep them.',
  },
  paid: {
    tone: 'success',
    message: 'Paid. Your tickets are yours — good luck.',
  },
  paid_unfulfillable: {
    tone: 'danger',
    message:
      'Your payment went through, but the tickets could no longer be held for you. A refund has been started and will return to the way you paid.',
  },
  failed: {
    tone: 'danger',
    message: 'The payment did not go through, so nothing was bought.',
  },
  expired: {
    tone: 'danger',
    message:
      'The time to pay ran out and the tickets went back into the draw. Nothing was charged.',
  },
  cancelled: { tone: 'danger', message: 'This order was cancelled.' },
  refunded: { tone: 'info', message: 'This order has been refunded.' },
  default: { tone: 'info', message: 'This order is being processed.' },
};
