import { ORDER_ACCESS_TOKEN_HEADER, OrderAccessResponseSchema } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { PaymentStatusWatch } from '@/components/payment-status-watch';
import { PrizeArt } from '@/components/prize-art';
import { apiFetch } from '@/lib/api';
import { ACCESS_COOKIE } from '@/lib/order-access';
import { formatDateTime, formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your payment', robots: { index: false } };

/**
 * Back from the provider (P6-8; OD-2; **D18 = B**; B10's "the redirect cannot
 * mark an order paid"; presentation rebuilt in UI-6).
 *
 * ## This page asserts nothing
 *
 * The customer has arrived from somewhere we do not control, carrying whatever
 * the provider chose to put in the URL. **None of it is an input.** The page
 * presents the return token to the API and prints what the database says. A
 * forged `?status=paid`, a replayed link, twenty refreshes — all produce the
 * same answer, because the only thing read from the URL is a credential whose
 * entire authority is "show me this one order".
 *
 * Confirmation reaches an order through a verified webhook or the reconciler. A
 * browser is neither, and there is no call this page could make that would
 * change that. What UI-6 added is a component that WATCHES for one of them to
 * land; it polls a read-only route and then asks the server to re-render, so
 * the words below are always the server's.
 *
 * ## Everything the customer is told is keyed on the ORDER
 *
 * Never on the attempt, and never on the URL. An attempt the provider calls
 * `succeeded` has delivered nothing until the order says `paid`, so the
 * attempt's own status is shown as a quiet aside and decides no wording.
 *
 * ## The ticket numbers (UI-8)
 *
 * Shown here as well as on the order page. This widens what the return link
 * displays, and deliberately so: the link already shows the order's lines,
 * quantities and total, and a customer who has just paid on a device they may
 * not be signed in on should be able to see what they bought. The numbers are
 * part of the order, not of the payment — nothing about the provider, the
 * reference or the instrument appears here, and the token still reaches one
 * order and still only reads.
 *
 * ## This page reads; it never writes
 *
 * The token arrives in the URL the provider was given, and the Route Handler
 * next door moves it into an HttpOnly cookie and sends the customer here
 * without it (§12). By the time this renders there is nothing left to
 * exchange, which is why it only ever calls `cookies().get`.
 *
 * Without the cookie it answers 404, the same as for any caller who has no
 * link, and says nothing about whether the order exists.
 */
export default async function PaymentReturnPage() {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  // No cookie, no page. The exchange sets it; arriving here without one means
  // the link was never presented, or it has already been cleared. Answering 404
  // says nothing about whether any particular order exists.
  if (!token) notFound();

  // A GET, with the credential in a header rather than the URL. It cannot be
  // a POST: this renders during a plain navigation, which sends no Origin, and
  // the API refuses every state-changing request without one. The route is
  // read-only (S2), so the method is also the truth about it.
  const result = await apiFetch(`/checkout/order-access`, {
    headers: { [ORDER_ACCESS_TOKEN_HEADER]: token },
    parse: (json) => OrderAccessResponseSchema.parse(json),
  });
  // Expired, revoked, or never valid — all the same answer, and all meaning
  // "this link no longer shows anything".
  if (!result.ok) notFound();

  const { order, payment } = result.data;
  const state = RETURN_STATES[order.status] ?? RETURN_STATES.default!;
  const price = (minor: number) => formatPrice(minor, order.currency, 'en-GB');
  const orderPath = `/${order.market}/orders/${order.id}`;
  const waiting = order.status === 'awaiting_payment';
  /*
   * Only when there is an attempt to ask about, and only while the answer
   * could still change.
   *
   * Built from the attempt the API just named, **not from the id in the
   * address**. That is the same rule the rest of this page follows: the URL is
   * a place the customer arrived from, not a source of facts. It also happens
   * to be the only correct choice — the address here is whatever the exchange
   * redirected to, and nothing has ever required it to name the live attempt.
   */
  const watchEndpoint =
    waiting && payment
      ? `/checkout/payments/${payment.id}/status?market=${order.market}&order=${order.id}`
      : null;

  return (
    <main id="main" className="page payment-page" data-testid="payment-return">
      <header className="payment-head">
        <p className="eyebrow">Order {order.orderNumber}</p>
        <h1>{state.heading}</h1>
      </header>

      {/* The tone carries no meaning on its own: the icon has a text label and
          the sentence below says the same thing in words. */}
      <p className={`notice notice--${state.tone} payment-state`} data-testid="return-status">
        <strong className="payment-state__label">{state.label}</strong>
        <span>{state.message}</span>
      </p>

      {waiting && (
        <div className="payment-pending" data-testid="return-pending-note">
          <p>
            We have not had confirmation from the payment provider yet. This page shows what our
            records say, and it updates itself while you wait.
          </p>
          {watchEndpoint && (
            <PaymentStatusWatch endpoint={watchEndpoint} initialOrderStatus={order.status} />
          )}
          {/* The no-JavaScript path, and the one that always works. */}
          <noscript>
            <p className="hint">Reload this page to check again.</p>
          </noscript>
        </div>
      )}

      <section className="panel" aria-labelledby="order-heading">
        <h2 id="order-heading">Your order</h2>
        <ul className="payment-lines" data-testid="return-items">
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
                {/*
                  The numbers, when the order has them. Nothing about the
                  payment: no provider, no reference, no card. The token's
                  authority is "show me this one order", and these are part of
                  that order exactly as the quantity and the total are.
                */}
                {item.ticketNumbers.length > 0 && (
                  <div>
                    <h4 className="ticket-numbers__title">
                      {item.ticketNumbers.length === 1
                        ? 'Your ticket number'
                        : 'Your ticket numbers'}
                    </h4>
                    <ul className="ticket-numbers" data-testid="return-ticket-numbers">
                      {item.ticketNumbers.map((n) => (
                        <li key={n} className="ticket" data-testid="return-ticket-number">
                          #{n}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>

        <p className="total">
          <span>Total</span>
          <span className="price" data-testid="return-total">
            {price(order.totalMinor)}
          </span>
        </p>
        <p className="hint">Placed {formatDateTime(order.createdAt, 'en-GB', order.market)}.</p>
        {payment && (
          <p className="hint" data-testid="return-attempt-status">
            {/* An aside, deliberately. It decides no wording above, and it
                never names the provider or its reference for the attempt. */}
            Payment attempt: {ATTEMPT_WORDS[payment.status] ?? payment.status}.
          </p>
        )}
      </section>

      <div className="payment-actions">
        <Link className="button button--gold" href={orderPath} data-testid="return-order-link">
          Go to your order
        </Link>
        <Link className="button button--quiet" href={`/${order.market}/draws`}>
          Browse more competitions
        </Link>
      </div>
    </main>
  );
}

/** The attempt, in plain words. Never a provider's vocabulary. */
const ATTEMPT_WORDS: Record<string, string> = {
  pending: 'started',
  processing: 'being processed by the provider',
  succeeded: 'completed',
  failed: 'did not go through',
  expired: 'ran out of time',
};

/**
 * What the customer is told, keyed on the ORDER's status.
 *
 * Never on the attempt's, and never on anything from the URL. An attempt the
 * provider calls succeeded has delivered nothing until the order says so.
 *
 * `label` exists so the state is never carried by colour alone — it is the one
 * word a screen reader or a monochrome display still gets.
 *
 * ## What is deliberately absent
 *
 * There is no wording for `failed`. **Nothing in the system moves an order to
 * that status** — what would is owner decision K-c and is still open — so a
 * sentence here would describe a transition that cannot happen. It falls to the
 * generic, like any status this build has not been told about.
 *
 * Nor is there wording for a second capture or a capture without settlement.
 * Those are finalisation OUTCOMES rather than order statuses, so they never
 * reach a customer through this map at all, and what should be said about them
 * is D22.2 and D22.3 — owner decisions, not wording to be guessed at here.
 */
const RETURN_STATES: Record<
  string,
  { tone: string; label: string; heading: string; message: string }
> = {
  awaiting_payment: {
    tone: 'info',
    label: 'Waiting',
    heading: 'Thanks — we are confirming your payment',
    message: 'We are waiting for the payment provider to confirm this.',
  },
  paid: {
    tone: 'success',
    label: 'Paid',
    heading: 'Paid — your tickets are yours',
    message: 'Your payment went through and your tickets are confirmed. Good luck.',
  },
  paid_unfulfillable: {
    tone: 'danger',
    label: 'Refund started',
    heading: 'Paid, but we could not hold your tickets',
    message:
      'Your payment went through, but the tickets could no longer be held for you. A refund has been started and will return to the way you paid.',
  },
  expired: {
    tone: 'danger',
    label: 'Expired',
    heading: 'The time to pay ran out',
    message:
      'The tickets went back into the draw and nothing was charged. You can enter again from the competition page.',
  },
  cancelled: {
    tone: 'danger',
    label: 'Cancelled',
    heading: 'This order was cancelled',
    message: 'Nothing was charged for it.',
  },
  refunded: {
    tone: 'info',
    label: 'Refunded',
    heading: 'This order has been refunded',
    message: 'The refund returns to the way you paid.',
  },
  partially_refunded: {
    tone: 'info',
    label: 'Partly refunded',
    heading: 'This order has been partly refunded',
    message: 'The refund returns to the way you paid.',
  },
  // Every status this build has no sentence for, including ones it may meet
  // before it has words for them. It claims nothing either way.
  default: {
    tone: 'info',
    label: 'In progress',
    heading: 'This order is being processed',
    message: 'Open your order for the latest on it.',
  },
};
