import type { Metadata } from 'next';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { PrizeArt } from '@/components/prize-art';
import { ReservationCountdown } from '@/components/reservation-countdown';
import { checkoutErrorMessage, fetchCart, fetchTerms } from '@/lib/checkout';
import { fetchDraw } from '@/lib/draws';
import { formatPrice } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { placeOrder } from '../checkout-actions';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

type Params = Promise<{ market: string }>;

/** The id the error banner carries, so controls can point at it and the
 *  redirect can bring the browser to it with no JavaScript at all. */
const ERROR_ID = 'checkout-error';

/**
 * Which control a refusal is actually about.
 *
 * An error banner that describes nothing is a banner a screen reader meets
 * once, at the top, and then leaves behind. These two sets let the message be
 * announced again on the control the customer has to go back and change —
 * which, for the two refusals they can do something about, is the answers or
 * the terms box.
 */
const ANSWER_ERRORS = new Set(['INVALID_SKILL_ANSWER']);
const TERMS_ERRORS = new Set(['TERMS_NOT_ACCEPTED', 'TERMS_VERSION_STALE', 'TERMS_UNAVAILABLE']);

/**
 * Checkout (P6-8; presentation rebuilt in UI-5).
 *
 * One form, one submission, one order. It shows what is held, the question
 * each draw asks, the terms version in force, and the total — then hands all
 * of it to `POST /checkout/orders`, which decides.
 *
 * **Nothing here validates anything.** The API re-reads the basket under lock,
 * re-checks the terms version, marks the answer, applies the per-person cap and
 * prices the order from the database. A wrong answer creates nothing at all —
 * no order, no spent idempotency key, basket and holds intact (ADR-0030) — and
 * the correct option never leaves the API, so this page could not reveal it
 * even if it tried.
 *
 * **The total is the API's, printed as given.** It is never summed from the
 * lines here: the lines a customer can see and the lines the API will sell are
 * not always the same set, and only one of those two is allowed to be the
 * price.
 *
 * **One render, one idempotency key.** It is minted here and travels in the
 * form, so pressing the button twice — or coming back and resubmitting — is
 * the SAME request to the API, which replays the order it already made rather
 * than refusing an emptied basket. A client-supplied key is safe by the API's
 * own design: the key is bound to a digest of the buyer and the purchase, so
 * one that is reused for anything else is refused and one belonging to
 * somebody else resolves to nothing.
 *
 * It is a plain form. There is no client component on this page, nothing here
 * needs JavaScript, and the browser is never the authority for any of it.
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
  const basketPath = `/${market.code}/basket`;
  /*
   * Nothing held means nothing to buy, and the basket is where that is
   * explained — it still lists the lapsed line and says what happened to it.
   *
   * The refusal travels with them. A hold that ran out between drawing this
   * page and pressing the button comes back here as an error, and this redirect
   * fires before the banner would have rendered; without carrying the code the
   * customer would arrive at the basket with no idea why they were sent there.
   */
  if (live.length === 0) {
    redirect(error ? `${basketPath}?error=${encodeURIComponent(error)}` : basketPath);
  }

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
      <>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
          <Link href={basketPath}>Basket</Link> › <span aria-current="page">Checkout</span>
        </nav>
        <header className="basket-head">
          <h1>Checkout</h1>
        </header>
        <p className="notice notice--danger" data-testid="checkout-unavailable">
          This market cannot take orders yet. Your tickets are still held in your basket.
        </p>
        <Link className="button button--quiet" href={basketPath}>
          Back to your basket
        </Link>
      </>
    );
  }

  // One per render, carried in the form: see the note above.
  const idempotencyKey = randomUUID();
  // The binding hold — the first of them to run out ends the whole checkout.
  const earliest = live.reduce((soonest, item) =>
    item.reservation.expiresAt < soonest.reservation.expiresAt ? item : soonest,
  );
  const describedByAnswer = error && ANSWER_ERRORS.has(error) ? ERROR_ID : undefined;
  const describedByTerms = error && TERMS_ERRORS.has(error) ? ERROR_ID : undefined;

  return (
    <div className="checkout" data-testid="checkout">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> › <Link href={basketPath}>Basket</Link>{' '}
        › <span aria-current="page">Checkout</span>
      </nav>

      <header className="basket-head">
        <h1>Checkout</h1>
        <p className="basket-head__note">
          Answer the question for each competition and accept the terms. Your tickets stay held
          until you have finished.
        </p>
      </header>

      {message && (
        /* `tabIndex` so the `#checkout-error` fragment the action redirects to
           can bring focus here. That is the whole mechanism — it works with
           JavaScript switched off, which a focus call would not. */
        <p
          className="notice notice--danger"
          role="alert"
          id={ERROR_ID}
          tabIndex={-1}
          data-testid="checkout-error"
        >
          {message}
        </p>
      )}

      <form action={placeOrder.bind(null, market.code)}>
        <input type="hidden" name="termsVersion" value={terms.active.version} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        <div className="basket">
          <div className="stack">
            {/* ------------------------------------------------ what and why */}
            <section className="panel" aria-labelledby="buying-heading">
              <h2 id="buying-heading">What you are buying</h2>
              <ul className="basket-lines" data-testid="checkout-lines">
                {live.map((item, index) => {
                  const r = item.reservation;
                  const question = draws[index]?.skillQuestion;
                  return (
                    <li key={item.id} className="basket-line" data-testid="checkout-line">
                      <div className="basket-line__media" aria-hidden="true">
                        <PrizeArt title={r.draw.title} />
                      </div>

                      <div className="basket-line__body">
                        <div className="basket-line__head">
                          <h3 className="basket-line__title">{r.draw.title}</h3>
                          <span className="badge badge--live">Held</span>
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
                            <dd className="price" data-testid="checkout-line-total">
                              {price(r.totalMinor, r.currency)}
                            </dd>
                          </div>
                        </dl>

                        {/* The question belongs to this draw, so it is asked
                            here rather than in a list of questions elsewhere —
                            there is never any doubt which one is being
                            answered. */}
                        {question && (
                          <fieldset
                            className="checkout-skill"
                            {...(describedByAnswer
                              ? { 'aria-describedby': describedByAnswer }
                              : {})}
                          >
                            <legend data-testid="skill-prompt">{question.prompt}</legend>
                            <div className="options">
                              {question.options.map((option) => (
                                <label className="option" key={option.id}>
                                  <input
                                    type="radio"
                                    name={`answer-${r.draw.slug}`}
                                    value={option.id}
                                    required
                                  />
                                  <span>{option.label}</span>
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        )}
                      </div>

                      <input type="hidden" name="item" value={`${r.draw.slug}|${r.quantity}`} />
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* ------------------------------------------------------- terms */}
            <section className="panel" aria-labelledby="terms-heading">
              <h2 id="terms-heading">Terms</h2>
              <p className="hint">
                Orders in {market.name} are placed under terms version{' '}
                <strong data-testid="checkout-terms-version">{terms.active.version}</strong>.
              </p>
              {/* No wording: the contract carries a version and nothing else
                  (terms content is Phase 12), and inventing some here would be
                  inventing the agreement itself. */}
              <div className="options">
                <label className="option">
                  <input
                    type="checkbox"
                    name="acceptTerms"
                    value="yes"
                    required
                    defaultChecked={terms.accepted === true}
                    data-testid="checkout-accept-terms"
                    {...(describedByTerms ? { 'aria-describedby': describedByTerms } : {})}
                  />
                  <span>I accept the terms and conditions.</span>
                </label>
              </div>
              {terms.accepted === true && (
                <p className="hint" data-testid="checkout-terms-accepted">
                  You have already accepted this version.
                </p>
              )}
            </section>
          </div>

          {/* ----------------------------------------------------- summary */}
          <aside className="basket-summary" aria-labelledby="summary-heading">
            <div className="panel">
              <h2 id="summary-heading" className="basket-summary__title">
                Your order
              </h2>

              <dl className="facts basket-summary__facts">
                <div>
                  <dt>Competitions</dt>
                  <dd>{live.length}</dd>
                </div>
                <div>
                  <dt>Entries</dt>
                  <dd>{live.reduce((sum, item) => sum + item.reservation.quantity, 0)}</dd>
                </div>
              </dl>

              <p className="total">
                <span>Total</span>
                <span className="price" data-testid="checkout-total">
                  {cart && cart.totalMinor !== null && cart.currency
                    ? price(cart.totalMinor, cart.currency)
                    : '—'}
                </span>
              </p>

              {/* The binding hold, counted by the server's clock. When this
                  reaches zero the tickets go back, whatever this page says. */}
              {cart && (
                <div className="checkout-hold">
                  <ReservationCountdown
                    expiresAt={earliest.reservation.expiresAt}
                    serverTime={cart.serverTime}
                  />
                </div>
              )}

              <button
                type="submit"
                className="button button--gold button--block"
                data-testid="checkout-submit"
              >
                Place order
              </button>
              <p className="hint">
                Placing the order does not pay for it. You will be able to pay on the next page.
              </p>

              <Link className="button button--quiet button--block" href={basketPath}>
                Back to your basket
              </Link>
            </div>
          </aside>
        </div>
      </form>
    </div>
  );
}
