import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { checkoutErrorMessage, fetchCart, fetchTerms } from '@/lib/checkout';
import { fetchDraw } from '@/lib/draws';
import { formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { placeOrder } from '../checkout-actions';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

type Params = Promise<{ market: string }>;

/**
 * Checkout (P6-8).
 *
 * One form, one submission, one order. It shows what the basket holds, the
 * terms the customer is agreeing to, and the skill question each draw asks —
 * and then hands all of it to `POST /checkout/orders`, which decides.
 *
 * **Nothing here validates anything.** The API re-reads the basket under lock,
 * re-checks the terms version, marks the answer, applies the per-person cap and
 * prices the order from the database. A wrong answer creates nothing at all —
 * no order, no spent idempotency key, basket and holds intact (ADR-0030) — and
 * the correct option never leaves the API, so this page could not reveal it
 * even if it tried.
 */
export default async function CheckoutPage({
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

  const [cart, terms] = await Promise.all([fetchCart(market.code), fetchTerms(market.code)]);
  const live = (cart?.items ?? []).filter((item) => item.reservation.status === 'active');
  // Nothing held means nothing to buy. The basket explains why.
  if (live.length === 0) redirect(`/${market.code}/basket`);

  // Each live line's draw, for its skill question. The question is the draw's,
  // so it is read from the draw rather than carried on the basket.
  const draws = await Promise.all(
    live.map((item) => fetchDraw(market.code, item.reservation.draw.slug)),
  );
  const message = checkoutErrorMessage(error);
  const price = (minor: number, currency: 'GBP' | 'EUR') =>
    formatPrice(minor, currency, market.locale);

  if (!terms?.checkoutAllowed || !terms.active) {
    return (
      <main className="page">
        <h1>Checkout</h1>
        <p className="notice notice--danger" data-testid="checkout-unavailable">
          This market cannot take orders yet.
        </p>
        <Link className="button button--quiet" href={`/${market.code}/basket`}>
          Back to your basket
        </Link>
      </main>
    );
  }

  return (
    <main className="page" data-testid="checkout">
      <h1>Checkout</h1>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="checkout-error">
          {message}
        </p>
      )}

      <form action={placeOrder.bind(null, market.code)}>
        <input type="hidden" name="termsVersion" value={terms.active.version} />

        <section className="panel">
          <h2>What you are buying</h2>
          <ul data-testid="checkout-lines">
            {live.map((item, index) => {
              const r = item.reservation;
              const draw = draws[index];
              const question = draw?.skillQuestion;
              return (
                <li key={item.id} data-testid="checkout-line">
                  <p>
                    <strong>{r.draw.title}</strong> — {r.quantity}{' '}
                    {r.quantity === 1 ? 'entry' : 'entries'} · {price(r.totalMinor, r.currency)}
                  </p>
                  <input type="hidden" name="item" value={`${r.draw.slug}|${r.quantity}`} />
                  {question ? (
                    <fieldset className="skill">
                      <legend data-testid="skill-prompt">{question.prompt}</legend>
                      {question.options.map((option) => (
                        <label key={option.id}>
                          <input
                            type="radio"
                            name={`answer-${r.draw.slug}`}
                            value={option.id}
                            required
                          />
                          {option.label}
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <h2>Terms</h2>
          <p>
            Version <strong data-testid="checkout-terms-version">{terms.active.version}</strong>.
          </p>
          <label>
            <input type="checkbox" name="acceptTerms" value="yes" required />I accept the terms and
            conditions.
          </label>
        </section>

        <section className="panel">
          <p className="total">
            <span>Total</span>
            <span className="price" data-testid="checkout-total">
              {cart!.totalMinor !== null && cart!.currency
                ? price(cart!.totalMinor, cart!.currency)
                : '—'}
            </span>
          </p>
          <button
            type="submit"
            className="button button--gold button--block"
            data-testid="checkout-submit"
          >
            Place order
          </button>
          <Link className="button button--quiet button--block" href={`/${market.code}/basket`}>
            Back to your basket
          </Link>
        </section>
      </form>
    </main>
  );
}
