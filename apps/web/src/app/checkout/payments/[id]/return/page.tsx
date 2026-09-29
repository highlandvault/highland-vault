import { ORDER_ACCESS_TOKEN_HEADER, OrderAccessResponseSchema } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { ACCESS_COOKIE } from '@/lib/order-access';
import { formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your payment', robots: { index: false } };

/**
 * Back from the provider (P6-8; OD-2; **D18 = B**; B10's "the redirect cannot
 * mark an order paid").
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
 * Confirmation reaches an order through a verified webhook or a trusted
 * server-side status check. A browser is neither, and there is no call this
 * page could make that would change that.
 *
 * ## This page reads; it never writes
 *
 * The token arrives in the URL the provider was given, and the Route Handler
 * next door moves it into an HttpOnly cookie and sends the customer here
 * without it (§12). By the time this renders there is nothing left to
 * exchange, which is why it only ever calls `cookies().get`.
 *
 * That split is not tidiness. A Server Component renders after the response
 * headers are committed, so Next.js refuses `cookies().set()` here — setting a
 * cookie is composing a response, and a Route Handler is what composes one.
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

  return (
    <main className="page" data-testid="payment-return">
      <h1>Order {order.orderNumber}</h1>

      <p className={`notice notice--${state.tone}`} data-testid="return-status">
        {state.message}
      </p>

      <section className="panel">
        <p>
          <span>Total</span>{' '}
          <strong className="price" data-testid="return-total">
            {price(order.totalMinor)}
          </strong>
        </p>
        {payment && (
          <p className="hint" data-testid="return-attempt-status">
            Payment attempt: {payment.status}
          </p>
        )}
        {order.status === 'awaiting_payment' && (
          <p className="hint" data-testid="return-pending-note">
            We have not had confirmation from the payment provider yet. This page shows what our
            records say; refresh in a moment.
          </p>
        )}
      </section>

      <Link className="button button--quiet" href={`/${order.market}/draws`}>
        Browse more draws
      </Link>
    </main>
  );
}

/**
 * What the customer is told, keyed on the ORDER's status.
 *
 * Never on the attempt's, and never on anything from the URL. An attempt the
 * provider calls succeeded has delivered nothing until the order says so.
 */
const RETURN_STATES: Record<string, { tone: string; message: string }> = {
  awaiting_payment: {
    tone: 'info',
    message: 'Thanks. We are waiting for the payment provider to confirm this.',
  },
  paid: { tone: 'success', message: 'Paid. Your tickets are yours — good luck.' },
  paid_unfulfillable: {
    tone: 'danger',
    message:
      'Your payment went through, but the tickets could no longer be held for you. A refund has been started and will return to the way you paid.',
  },
  failed: { tone: 'danger', message: 'The payment did not go through, so nothing was bought.' },
  expired: {
    tone: 'danger',
    message: 'The time to pay ran out and the tickets went back into the draw.',
  },
  default: { tone: 'info', message: 'This order is being processed.' },
};
