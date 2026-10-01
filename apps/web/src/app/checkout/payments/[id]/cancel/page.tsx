import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Payment cancelled', robots: { index: false } };

/**
 * The customer backed out at the provider (P6-8).
 *
 * **No token, and none needed.** They never completed anything, so they still
 * have whatever identity they arrived with and their own order page will show
 * them the truth. The cancel URL carries no credential precisely because it
 * does not have to (`customerUrl` only puts the token on the return).
 *
 * It changes nothing either. Backing out at a provider is not an instruction
 * to us: the attempt stays as it is until it times out (D3a) or the customer
 * comes back to it (D3b = A), and the order keeps its deadline. Saying "your
 * payment was cancelled" as though we had acted on it would be a small lie.
 */
export default function PaymentCancelledPage() {
  return (
    <main id="main" className="page" data-testid="payment-cancelled">
      <h1>Payment not completed</h1>
      <p className="notice notice--info" data-testid="cancel-status">
        You came back without paying, so nothing has been charged. Your tickets are still held for a
        short while — open your order to try again.
      </p>
      <Link className="button button--quiet" href="/">
        Back to Highland Vault
      </Link>
    </main>
  );
}
