import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PrizeArt } from '@/components/prize-art';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { checkoutErrorMessage, fetchOrder } from '@/lib/checkout';
import { formatDateTime, formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { startPayment } from '../../checkout-actions';

export const metadata: Metadata = { title: 'Your order', robots: { index: false } };

type Params = Promise<{ market: string; id: string }>;

/**
 * The order, and where its payment stands (P6-8, §19; payment states in UI-6).
 *
 * The status shown is **the order's**, read from the API. A payment attempt
 * the provider calls succeeded has delivered nothing until the order says
 * `paid`, and nothing a browser does — arriving, refreshing, or carrying any
 * query string it likes — can move it. Confirmation reaches the order through
 * a verified webhook or the reconciler, and through nothing else.
 *
 * The countdown runs to the order's own payment deadline. That is honest: the
 * deadline is set 90 seconds before the earliest hold expires (D1 = B), so it
 * can never reach zero while the tickets are already gone.
 *
 * ## Attempt expiry is not order expiry
 *
 * They are different events and UI-6 keeps them distinguishable. An ATTEMPT
 * lapses 120 seconds after it starts (D3a) and takes nothing with it — the
 * order stays payable and the customer may start another, which is the whole
 * reason the expiry sweep closes lapsed attempts at all. An ORDER expires at
 * its deadline, and that is the end of it. Saying "your payment expired" for
 * the first would tell somebody they had lost tickets they still hold.
 *
 * This page cannot see the attempt — the order contract carries no payment —
 * so it does not guess at one. It says what it knows: the order is still
 * payable, here is how long for, and here is the button.
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
  const when = (iso: string) => formatDateTime(iso, market.locale, market.code);

  // Payable means exactly this: the order is still awaiting payment and its
  // own deadline has not passed. The API decides both; this only reads them —
  // against the API's clock, which it sends for the purpose, rather than this
  // renderer's. Whether a deadline has passed is not a thing for two machines
  // to disagree about.
  const payable =
    order.status === 'awaiting_payment' &&
    Date.parse(order.expiresAt) > Date.parse(order.serverTime);
  /*
   * The gap between the deadline passing and the sweep noticing it.
   *
   * The order still SAYS `awaiting_payment` for up to a minute after its
   * deadline, because an order is moved to `expired` by the worker's sweep and
   * not by anyone reading it. Taking the status at face value in that window
   * would put "pay before the time runs out" above a panel that has already
   * stopped offering the button — two true-sounding statements that contradict
   * each other. It is the same distinction the attempt/order note above draws,
   * met from the other side.
   */
  const deadlinePassed = order.status === 'awaiting_payment' && !payable;
  const state = deadlinePassed
    ? ORDER_STATES.deadline_passed!
    : (ORDER_STATES[order.status] ?? ORDER_STATES.default!);
  // A customer who came back from a provider and found nothing confirmed is
  // being invited to try again, not told they failed.
  const retrying = payable && error !== undefined;

  return (
    <div className="order-page" data-testid="order">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
        <span aria-current="page">Order {order.orderNumber}</span>
      </nav>

      {/* The order number stays the heading. The state is the banner's job
          below, as it always was — a heading that restates the status says the
          same thing twice and gives the page no stable title. */}
      <header className="payment-head">
        <h1>Order {order.orderNumber}</h1>
      </header>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="order-error">
          {message}
        </p>
      )}

      {/* The label is the state in words, so it never depends on the colour. */}
      <p className={`notice notice--${state.tone} payment-state`} data-testid="order-status">
        <strong className="payment-state__label">{state.label}</strong>
        <span>{state.message}</span>
      </p>

      <div className="order-layout">
        <section className="panel" aria-labelledby="bought-heading">
          <h2 id="bought-heading">What you bought</h2>
          <ul className="payment-lines" data-testid="order-items">
            {order.items.map((item) => (
              <li className="payment-line" key={item.draw.slug}>
                <div className="payment-line__media" aria-hidden="true">
                  <PrizeArt title={item.draw.title} />
                </div>
                <div className="payment-line__body">
                  <h3 className="payment-line__title">{item.draw.title}</h3>
                  <dl className="facts">
                    <div>
                      <dt>Entries</dt>
                      <dd>{item.quantity}</dd>
                    </div>
                    <div>
                      <dt>Line total</dt>
                      <dd className="price">{price(item.totalMinor)}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
          <p className="total">
            <span>Total</span>
            <span className="price" data-testid="order-total">
              {price(order.totalMinor)}
            </span>
          </p>
          <p className="hint">Placed {when(order.createdAt)}.</p>
        </section>

        <aside className="payment-aside" aria-labelledby="pay-heading">
          <div className="panel">
            {payable ? (
              <>
                <h2 id="pay-heading" className="payment-aside__title">
                  {retrying ? 'Try your payment again' : 'Pay for your order'}
                </h2>
                <p data-testid="order-deadline">Pay by {when(order.expiresAt)}.</p>
                <ReservationCountdown expiresAt={order.expiresAt} serverTime={order.serverTime} />
                {retrying && (
                  <p className="hint" data-testid="order-retry-note">
                    Your tickets are still held. Starting again picks up the payment you already
                    have if it is still open, so you will not be charged twice.
                  </p>
                )}
                {/*
                  The SAME initiation flow, unchanged: one Server Action, an
                  idempotency key per submission, and the API's own rule that an
                  order with a live attempt is sent back to that attempt rather
                  than given a second one (D3b = A). "Retry" is a word on a
                  button here, not a different code path.
                */}
                <form action={startPayment.bind(null, market.code, order.id)}>
                  <button
                    type="submit"
                    className="button button--gold button--block"
                    data-testid="order-pay"
                  >
                    {retrying ? 'Try again' : 'Pay now'}
                  </button>
                </form>
                <p className="hint">
                  You will be taken to our payment provider and brought back here afterwards.
                </p>
              </>
            ) : (
              <>
                <h2 id="pay-heading" className="payment-aside__title">
                  Payment
                </h2>
                <p className="hint" data-testid="order-not-payable">
                  {state.aside}
                </p>
              </>
            )}

            <Link className="button button--quiet button--block" href={`/${market.code}/draws`}>
              Browse more competitions
            </Link>
          </div>
        </aside>
      </div>
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
 *
 * ## What is deliberately absent
 *
 * No wording for `failed`. **Nothing in the system moves an order to it** —
 * what would is owner decision K-c, still open — so a sentence for it would
 * describe a transition that cannot happen. It falls to the generic.
 *
 * `label` is the state in words, so nothing here is carried by colour alone.
 * `aside` is what the payment panel says once there is nothing left to pay.
 */
const ORDER_STATES: Record<
  string,
  { tone: string; label: string; message: string; aside: string }
> = {
  awaiting_payment: {
    tone: 'info',
    label: 'Awaiting payment',
    message: 'Your tickets are held. Pay before the time runs out to keep them.',
    aside: 'This order is no longer awaiting payment.',
  },
  paid: {
    tone: 'success',
    label: 'Paid',
    message: 'Paid. Your tickets are yours — good luck.',
    aside: 'This order is paid. There is nothing left to pay.',
  },
  paid_unfulfillable: {
    tone: 'danger',
    label: 'Refund started',
    message:
      'Your payment went through, but the tickets could no longer be held for you. A refund has been started and will return to the way you paid.',
    aside: 'A refund has been started for this order.',
  },
  expired: {
    tone: 'danger',
    label: 'Expired',
    message:
      'The tickets went back into the draw and nothing was charged. You can enter again from the competition page.',
    aside: 'The time to pay has passed, so this order can no longer be paid.',
  },
  /*
   * Not a status the API ever returns — a derived one, for the minute between
   * a deadline passing and the sweep recording it. It says only what is
   * certainly true in that window: the time has gone and nothing was charged.
   * It does not say the tickets are back in the draw, because the sweep that
   * releases them has by definition not run yet.
   */
  deadline_passed: {
    tone: 'danger',
    label: 'Expired',
    message: 'This order can no longer be paid, and nothing was charged for it.',
    aside: 'The time to pay has passed, so this order can no longer be paid.',
  },
  cancelled: {
    tone: 'danger',
    label: 'Cancelled',
    message: 'Nothing was charged for it.',
    aside: 'This order was cancelled, so there is nothing to pay.',
  },
  refunded: {
    tone: 'info',
    label: 'Refunded',
    message: 'The refund returns to the way you paid.',
    aside: 'This order has been refunded.',
  },
  partially_refunded: {
    tone: 'info',
    label: 'Partly refunded',
    message: 'The refund returns to the way you paid.',
    aside: 'This order has been partly refunded.',
  },
  default: {
    tone: 'info',
    label: 'In progress',
    message: 'There is nothing for you to do while this is in progress.',
    aside: 'There is nothing to pay on this order at the moment.',
  },
};
