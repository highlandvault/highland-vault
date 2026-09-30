import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EntryPanel } from '@/components/entry-panel';
import { PrizeArt } from '@/components/prize-art';
import { StatusBadge } from '@/components/status-badge';
import { fetchTerms } from '@/lib/checkout';
import { fetchDraw } from '@/lib/draws';
import { entryErrorMessage, fetchAvailability } from '@/lib/reservations';
import { formatCount, formatDateTime, formatPrice, formatRelative, ordinal } from '@/lib/format';
import { fetchMarket } from '@/markets';
import { addToBasket } from '../../cart-actions';

type Params = Promise<{ market: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { market, slug } = await params;
  const draw = await fetchDraw(market, slug).catch(() => null);
  if (!draw) return { title: 'Competition' };
  return {
    title: draw.title,
    // The draw's own words, never a generated summary of them.
    ...(draw.description ? { description: draw.description.slice(0, 200) } : {}),
  };
}

/**
 * One competition (UI-3).
 *
 * ## Everything here is the API's answer
 *
 * The prizes, the skill question, the price, the cap, the timings and the
 * status all arrive from `GET /markets/:market/draws/:slug`, and the page adds
 * nothing to them. There are no invented statistics, no entrant counts, no
 * urgency the data does not support and no compliance claims — the contract
 * carries none of those, and inventing them here is how a product page starts
 * lying. Prize photography is still blocked (O14), so the artwork is
 * `PrizeArt`'s branded placeholder, framed rather than hidden.
 *
 * ## What it can and cannot do
 *
 * Adding to the basket is a real allocation through the ticket engine, under
 * the same locks and the same per-person cap as everywhere else — this page
 * forwards a quantity and shows what the API says back. It takes no payment,
 * places no order and verifies no address. The limits it displays are
 * guidance: the API enforces them and its refusal is what the customer reads.
 */
export default async function DrawDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ error?: string }>;
}) {
  const { market: code, slug } = await params;
  const { error } = await searchParams;
  const market = await fetchMarket(code);
  if (!market) notFound();
  // Unknown, unpublished, cancelled or another market's draw: all 404.
  const draw = await fetchDraw(market.code, slug);
  if (!draw) notFound();
  // Both are display-only and both tolerate failure: a page that cannot say
  // how many tickets are left is still worth reading.
  const [availability, terms] = await Promise.all([
    fetchAvailability(market.code, draw.slug),
    fetchTerms(market.code),
  ]);
  const drawPath = `/${market.code}/draws/${draw.slug}`;

  const when = (iso: string) => formatDateTime(iso, market.locale, market.code);
  const price = formatPrice(draw.ticketPriceMinor, draw.currency, market.locale);
  const open = draw.status === 'live';
  const timing = draw.status === 'scheduled' ? draw.opensAt : draw.closesAt;
  const timingLabel =
    draw.status === 'scheduled' ? 'Opens' : draw.status === 'live' ? 'Closes' : 'Closed';

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
        <Link href={`/${market.code}/draws`}>Competitions</Link> ›{' '}
        <span aria-current="page">{draw.title}</span>
      </nav>

      {/* ------------------------------------------------------------- hero */}
      <section className="draw-hero" aria-labelledby="draw-title-heading">
        <div className="draw-hero__media">
          <PrizeArt title={draw.prizes[0]?.title ?? draw.title} />
        </div>
        <div className="draw-hero__copy">
          <p className="draw-hero__meta">
            <span className="eyebrow">{market.name}</span>
            <StatusBadge status={draw.status} />
          </p>
          <h1 id="draw-title-heading" data-testid="draw-title">
            {draw.title}
          </h1>
          {draw.description && <p className="draw-hero__lede">{draw.description}</p>}

          <dl className="draw-hero__facts">
            <div>
              <dt>Entry</dt>
              <dd className="price">{price}</dd>
            </div>
            <div>
              <dt>{timingLabel}</dt>
              <dd>{formatRelative(timing, market.locale)}</dd>
            </div>
            <div>
              <dt>{draw.winnerPositions === 1 ? 'Winner' : 'Winners'}</dt>
              <dd>{formatCount(draw.winnerPositions, market.locale)}</dd>
            </div>
          </dl>

          {/* Only when entries are actually open: a second disabled button
              would say the same thing as the entry panel's, twice. */}
          {open && (
            <a className="button button--gold draw-hero__cta" href="#entry">
              Enter this competition
            </a>
          )}
        </div>
      </section>

      <div className="detail">
        <div className="stack">
          {/* --------------------------------------------------------- prizes */}
          <section className="panel" aria-labelledby="prizes">
            <h2 id="prizes">
              {draw.prizes.length === 1 ? 'The prize' : `${draw.prizes.length} prizes`}
            </h2>
            <ol className="prize-list" data-testid="prize-list">
              {draw.prizes.map((prize) => (
                <li key={prize.position}>
                  <span className="prize-rank" aria-label={`${ordinal(prize.position)} prize`}>
                    {ordinal(prize.position)}
                  </span>
                  <div>
                    <h3>{prize.title}</h3>
                    {prize.description && <p>{prize.description}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ------------------------------------------------- skill question */}
          <section className="panel" aria-labelledby="skill" data-testid="skill-question">
            <h2 id="skill">The skill question</h2>
            <p className="skill-prompt">
              <strong>{draw.skillQuestion.prompt}</strong>
            </p>
            <ul className="answer-list">
              {draw.skillQuestion.options.map((option) => (
                <li key={option.id}>{option.label}</li>
              ))}
            </ul>
            <p className="hint">
              Every entry answers this question at checkout. The answer is checked by the server,
              and a wrong answer buys nothing.
            </p>
          </section>

          {/* ------------------------------------------------ how entry works */}
          <section className="panel" aria-labelledby="entry-steps">
            <h2 id="entry-steps">How this competition works</h2>
            <ol className="steps steps--compact">
              <li className="step">
                <span className="step__number" aria-hidden="true">
                  01
                </span>
                <h3 className="step__title">Choose your entries</h3>
                <p>
                  Up to {formatCount(draw.maxPerPerson, market.locale)} per person. Your ticket
                  numbers are held for you as soon as you add them to your basket.
                </p>
              </li>
              <li className="step">
                <span className="step__number" aria-hidden="true">
                  02
                </span>
                <h3 className="step__title">Answer and check out</h3>
                <p>Answer the skill question, accept the terms, and pay for your order.</p>
              </li>
              <li className="step">
                <span className="step__number" aria-hidden="true">
                  03
                </span>
                <h3 className="step__title">The draw closes</h3>
                <p>
                  Entries close on <time dateTime={draw.closesAt}>{when(draw.closesAt)}</time>.
                  {draw.winnerPositions > 1
                    ? ` ${formatCount(draw.winnerPositions, market.locale)} winners are drawn from all the tickets sold.`
                    : ' One winner is drawn from all the tickets sold.'}
                </p>
              </li>
            </ol>
            {/* A real state, and one worth knowing before filling a basket:
                without an active terms version the API refuses to create an
                order (ADR-0031). No wording is shown because the contract
                carries none — only which version is in force. */}
            {terms && !terms.checkoutAllowed && (
              <p className="notice notice--danger" role="status" data-testid="terms-unavailable">
                Entries can be added to your basket, but checkout is not available in {market.name}{' '}
                yet.
              </p>
            )}
            {terms?.active && (
              <p className="hint" data-testid="terms-version">
                Orders in {market.name} are placed under terms version {terms.active.version}, shown
                in full at checkout.
              </p>
            )}
          </section>
        </div>

        {/* ---------------------------------------------------------- aside */}
        <aside className="detail__aside" aria-label="Entry">
          <div className="panel">
            <EntryPanel
              status={draw.status}
              currency={draw.currency}
              locale={market.locale}
              ticketPriceMinor={draw.ticketPriceMinor}
              maxPerPerson={draw.maxPerPerson}
              available={availability?.available ?? null}
              totalTickets={draw.totalTickets}
              allowance={availability?.allowance ?? null}
              loginHref={`/login?next=${encodeURIComponent(drawPath)}`}
              error={entryErrorMessage(error)}
              action={addToBasket.bind(null, market.code, draw.slug)}
            />
          </div>
          <div className="panel">
            <h2 className="detail__aside-title">Competition details</h2>
            <dl className="facts" data-testid="draw-facts">
              <div>
                <dt>Entry price</dt>
                <dd className="price">{price}</dd>
              </div>
              <div>
                <dt>Tickets in this draw</dt>
                <dd>{formatCount(draw.totalTickets, market.locale)}</dd>
              </div>
              <div>
                <dt>Maximum per person</dt>
                <dd>{formatCount(draw.maxPerPerson, market.locale)}</dd>
              </div>
              <div>
                <dt>{draw.winnerPositions === 1 ? 'Winner' : 'Winners'}</dt>
                <dd>{formatCount(draw.winnerPositions, market.locale)}</dd>
              </div>
              <div>
                <dt>Opens</dt>
                <dd>
                  <time dateTime={draw.opensAt}>{when(draw.opensAt)}</time>
                </dd>
              </div>
              <div>
                <dt>Closes</dt>
                <dd>
                  <time dateTime={draw.closesAt} data-testid="draw-closes">
                    {when(draw.closesAt)}
                  </time>
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </>
  );
}
