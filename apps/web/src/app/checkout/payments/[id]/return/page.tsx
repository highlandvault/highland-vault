import { OrderAccessResponseSchema } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { formatPrice } from '@/lib/format';

export const metadata: Metadata = { title: 'Your payment', robots: { index: false } };

/** Where the return link is kept once it is out of the URL. Per-order, short-lived. */
const ACCESS_COOKIE = 'hv_order_access';

type Params = Promise<{ id: string }>;

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
 * ## The token leaves the URL immediately
 *
 * It arrives as `?t=…` because the provider had to be given a URL before the
 * customer left. A bearer credential in a URL ends up in browser history, in
 * referrers and in logs — so the first thing this page does is move it into an
 * HttpOnly cookie and redirect to a clean address (§12). After that the link
 * still works if reopened, and the visible URL carries nothing.
 */
export default async function PaymentReturnPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const fromUrl = typeof query.t === 'string' ? query.t : null;

  if (fromUrl) {
    // Out of the URL, into an HttpOnly cookie, and straight back here without
    // it. The cookie outlives the redirect; the URL does not keep the secret.
    const store = await cookies();
    store.set(ACCESS_COOKIE, fromUrl, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/checkout/payments',
      // The API decides the real lifetime; this only stops the browser holding
      // it longer than it could possibly be useful.
      maxAge: 60 * 60,
      secure: process.env.NODE_ENV === 'production',
    });
    redirect(`/checkout/payments/${id}/return`);
  }

  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) notFound();

  const result = await apiFetch(`/checkout/order-access`, {
    method: 'POST',
    body: { token },
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
