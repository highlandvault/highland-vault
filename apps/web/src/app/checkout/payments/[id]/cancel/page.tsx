import { ORDER_ACCESS_TOKEN_HEADER, OrderAccessResponseSchema } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api';
import { ACCESS_COOKIE } from '@/lib/order-access';

export const metadata: Metadata = { title: 'Payment cancelled', robots: { index: false } };

/**
 * The customer backed out at the provider (P6-8; routing improved in UI-6).
 *
 * **No token, and none needed.** They never completed anything, so they still
 * have whatever identity they arrived with and their own order page will show
 * them the truth. The cancel URL carries no credential precisely because it
 * does not have to.
 *
 * It changes nothing either. Backing out at a provider is not an instruction
 * to us: the attempt stays as it is until it times out (D3a) or the customer
 * comes back to it (D3b = A), and the order keeps its deadline. Saying "your
 * payment was cancelled" as though we had acted on it would be a small lie, and
 * calling a payment route merely because somebody landed here would be worse.
 *
 * ## Why finding the order is conditional
 *
 * The cancel address carries the ATTEMPT's id and nothing else — by design, as
 * the API's `customerUrl` says. There is no read that turns an attempt id alone
 * into an order: every route that could is scoped by market and order, which
 * this page was never given.
 *
 * So it uses the one credential it may already hold. If the customer returned
 * from a provider earlier in this visit, the access cookie is still there, and
 * the order it opens names its latest attempt. **When that attempt is the one
 * in this address, the cookie is talking about this order and the page can link
 * straight to it.** When it is not — a different order, or no cookie at all —
 * the page says what is true and offers the way back it can stand behind. No
 * guessing, no fishing through the customer's other orders, and no ownership
 * rule bent to make a link appear.
 */
export default async function PaymentCancelledPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const orderPath = await resolveOrderPath(id);

  return (
    <main id="main" className="page payment-page" data-testid="payment-cancelled">
      <header className="payment-head">
        <h1>Payment not completed</h1>
      </header>

      <p className="notice notice--info payment-state" data-testid="cancel-status">
        <strong className="payment-state__label">Not paid</strong>
        <span>
          You came back without paying, so nothing has been charged. Your tickets are still held for
          a short while — open your order to try again.
        </span>
      </p>

      <div className="payment-actions">
        {orderPath ? (
          <Link className="button button--gold" href={orderPath} data-testid="cancel-order-link">
            Back to your order
          </Link>
        ) : (
          // Nothing to link to that could be proved to be theirs. The account
          // page is where their orders are reachable from, and it is honest
          // about needing them to be signed in.
          <Link className="button button--gold" href="/account" data-testid="cancel-account-link">
            Go to your account
          </Link>
        )}
        <Link className="button button--quiet" href="/">
          Back to Highland Vault
        </Link>
      </div>
    </main>
  );
}

/**
 * The order this attempt belongs to, if it can be shown to be this one.
 *
 * Read-only throughout: one presentation of a credential the customer already
 * has, to a route that cannot write. A refusal of any kind — no cookie, an
 * expired token, a revoked one — is simply no link.
 */
async function resolveOrderPath(paymentId: string): Promise<string | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const result = await apiFetch(`/checkout/order-access`, {
    headers: { [ORDER_ACCESS_TOKEN_HEADER]: token },
    parse: (json) => OrderAccessResponseSchema.parse(json),
  });
  if (!result.ok) return null;

  const { order, payment } = result.data;
  // The check that makes this safe rather than a guess: the order this cookie
  // opens must be the one whose attempt is named in the address.
  if (!payment || payment.id !== paymentId) return null;
  return `/${order.market}/orders/${order.id}`;
}
