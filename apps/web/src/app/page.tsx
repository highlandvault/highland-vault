import type { Market, PublicDrawSummary } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DrawCountdown } from '@/components/draw-countdown';
import { DrawRowCard } from '@/components/draw-row-card';
import {
  ArrowIcon,
  BottleIcon,
  ClockIcon,
  DiamondIcon,
  GlobeIcon,
  ListIcon,
  QuestionIcon,
  ShieldIcon,
  TicketIcon,
  TrophyIcon,
} from '@/components/icons';
import { PrizeArt } from '@/components/prize-art';
import { StatusBadge } from '@/components/status-badge';
import { fetchDraws } from '@/lib/draws';
import { formatCount, formatDateTime, formatPrice } from '@/lib/format';
import { fetchAvailability } from '@/lib/reservations';
import { fetchMarkets } from '@/markets';

export const metadata: Metadata = {
  title: { absolute: 'Highland Vault — exceptional prizes, one fair draw' },
  description:
    'Carefully selected prize draws with transparent entry, clear rules and a simple way to play.',
};

// Which markets are open, and which draws are live in them, are both facts
// about right now.
export const dynamic = 'force-dynamic';

type Featured = { draw: PublicDrawSummary; market: Market };

/**
 * The draws worth the front page, across every open market.
 *
 * There is no cross-market draw endpoint, so the open markets are asked in
 * parallel and their answers merged: live before scheduled, soonest closing
 * first. A market whose listing fails contributes nothing rather than failing
 * the page — the right trade for a homepage and the wrong one for a listing.
 */
async function featuredDraws(markets: Market[]): Promise<Featured[]> {
  const perMarket = await Promise.all(
    markets.map(async (market) => {
      const result = await fetchDraws(market.code);
      return result.ok ? result.draws.map((draw) => ({ draw, market })) : [];
    }),
  );
  const rank = (status: string) => (status === 'live' ? 0 : 1);
  return perMarket
    .flat()
    .filter(({ draw }) => draw.status === 'live' || draw.status === 'scheduled')
    .sort(
      (a, b) =>
        rank(a.draw.status) - rank(b.draw.status) ||
        Date.parse(a.draw.closesAt) - Date.parse(b.draw.closesAt),
    );
}

export default async function HomePage() {
  const markets = await fetchMarkets();
  const open = markets ?? [];
  const all = open.length > 0 ? await featuredDraws(open) : [];
  const featured = all[0] ?? null;
  const secondary = all.slice(1, 4);

  /*
   * Availability for the headline draw only.
   *
   * One request, not one per card. The listing endpoint carries no ticket
   * counts, so a progress figure has to come from the per-draw availability
   * route, and asking it for every card on the page is the N+1 this project
   * has already refused once. The headline draw is where the figure earns its
   * request; the cards below show price and timing, which the list payload
   * already has.
   */
  const availability = featured
    ? await fetchAvailability(featured.market.code, featured.draw.slug)
    : null;
  // `available` counts tickets nobody holds, so taken = total − available. That
  // includes live holds as well as sold tickets, which is what "entries" means
  // to somebody deciding whether to join.
  const taken = availability ? availability.total - availability.available : null;
  const percent =
    availability && availability.total > 0 && taken !== null
      ? Math.min(100, Math.round((taken / availability.total) * 100))
      : null;

  const featuredHref = featured
    ? `/${featured.market.code}/draws/${featured.draw.slug}`
    : open.length === 1
      ? `/${open[0]!.code}/draws`
      : '#competitions';
  const browseHref = open.length === 1 ? `/${open[0]!.code}/draws` : '#competitions';

  return (
    <main id="main" className="home">
      {/* -------------------------------------------------------------- hero */}
      <section className="hero-band" aria-labelledby="hero-heading">
        <div className="container hero-band__inner">
          <div className="hero-band__copy">
            <p className="rule-eyebrow">
              <span className="eyebrow">{featured ? 'Featured draw' : 'Highland Vault'}</span>
              <span className="rule-eyebrow__rule" aria-hidden="true" />
            </p>

            <h1 id="hero-heading" className="hero-band__title" data-testid="hero-title">
              {featured ? (
                <>
                  Win <em>{featured.draw.headlinePrize ?? featured.draw.title}</em>
                </>
              ) : (
                <>
                  Exceptional prizes.
                  <br />
                  One fair draw.
                </>
              )}
            </h1>

            <p className="hero-band__lede">
              {featured
                ? 'Every draw shows its prizes, closing time and entry price before you enter. Every entry answers a skill question.'
                : 'Carefully selected prize draws with transparent entry, clear rules and a simple way to play.'}
            </p>

            {/* Badges the data actually supports: nothing here is decoration. */}
            {featured && (
              <ul className="pill-row" data-testid="hero-badges">
                <li>
                  <span className="pill">
                    <GlobeIcon className="pill__icon" />
                    {featured.market.name}
                  </span>
                </li>
                <li>
                  <StatusBadge status={featured.draw.status} />
                </li>
                {featured.draw.winnerPositions > 1 && (
                  <li>
                    <span className="pill">
                      <TrophyIcon className="pill__icon" />
                      {featured.draw.winnerPositions} winner positions
                    </span>
                  </li>
                )}
              </ul>
            )}

            <ul className="value-row" data-testid="hero-values">
              <li>
                <QuestionIcon className="value-row__icon" />
                <span>
                  <strong>Skill question</strong>
                  On every entry
                </span>
              </li>
              <li>
                <ShieldIcon className="value-row__icon" />
                <span>
                  <strong>Secure checkout</strong>
                  Card details never held here
                </span>
              </li>
              <li>
                <ClockIcon className="value-row__icon" />
                <span>
                  <strong>Tickets held</strong>
                  From the moment you add them
                </span>
              </li>
              <li>
                <ListIcon className="value-row__icon" />
                <span>
                  <strong>Published rules</strong>
                  Prizes and timings up front
                </span>
              </li>
            </ul>

            <div className="cta-row">
              <Link className="button button--blue" href={featuredHref}>
                Enter now
                <ArrowIcon className="button__arrow" />
              </Link>
              <Link className="link-arrow" href={browseHref}>
                View all competitions <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          {/* ------------------------------------------------- hero artwork */}
          <div className="hero-band__stage">
            <div className="hero-band__art">
              <PrizeArt
                title={featured?.draw.headlinePrize ?? featured?.draw.title ?? 'Highland Vault'}
              />
            </div>

            {featured && (
              <div className="draw-ticket" data-testid="hero-card">
                <DrawCountdown
                  to={
                    featured.draw.status === 'live' ? featured.draw.closesAt : featured.draw.opensAt
                  }
                  label={featured.draw.status === 'live' ? 'Draw closes in' : 'Draw opens in'}
                />

                {taken !== null && percent !== null && availability && (
                  <div className="meter" data-testid="hero-entries">
                    <p className="meter__figures">
                      <strong>{formatCount(taken, featured.market.locale)}</strong> /{' '}
                      {formatCount(availability.total, featured.market.locale)} entries
                      <span className="meter__percent">{percent}%</span>
                    </p>
                    <div
                      className="meter__track"
                      role="progressbar"
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Entries taken"
                    >
                      <span className="meter__fill" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                )}

                <p className="draw-ticket__price">
                  <span className="price">
                    {formatPrice(
                      featured.draw.ticketPriceMinor,
                      featured.draw.currency,
                      featured.market.locale,
                    )}
                  </span>
                  <span className="draw-ticket__per">per entry</span>
                </p>

                <Link className="button button--blue button--block" href={featuredHref}>
                  Enter now
                  <ArrowIcon className="button__arrow" />
                </Link>

                <ul className="draw-ticket__notes">
                  <li>
                    <TicketIcon className="draw-ticket__note-icon" />
                    Up to {formatCount(featured.draw.maxPerPerson, featured.market.locale)} per
                    person
                  </li>
                  <li>
                    <ClockIcon className="draw-ticket__note-icon" />
                    <time
                      dateTime={featured.draw.closesAt}
                      title={formatDateTime(
                        featured.draw.closesAt,
                        featured.market.locale,
                        featured.market.code,
                      )}
                    >
                      Closes{' '}
                      {formatDateTime(
                        featured.draw.closesAt,
                        featured.market.locale,
                        featured.market.code,
                      )}
                    </time>
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- markets */}
      {open.length > 0 && (
        <section className="home-section" aria-labelledby="markets-heading">
          <div className="container">
            <div className="rule-head">
              <h2 id="markets-heading" className="rule-head__title">
                Choose your market
              </h2>
              <span className="rule-head__rule" aria-hidden="true" />
              <p className="rule-head__aside">Select a market to see its current draws</p>
            </div>

            <ul className="tile-row" data-testid="markets">
              {open.map((market, index) => (
                <li key={market.code}>
                  {/* The first is outlined the way the reference marks a
                      selection. It is a visual lead, not a stored choice: the
                      market is decided by the URL, and the API decides which
                      markets exist at all. */}
                  <Link
                    className={`tile${index === 0 ? ' tile--lead' : ''}`}
                    href={`/${market.code}/draws`}
                  >
                    <span className="tile__art" aria-hidden="true">
                      <span className={`tile__scene tile__scene--${index % 4}`} />
                    </span>
                    <span className="tile__body">
                      <GlobeIcon className="tile__icon" />
                      <span className="tile__title">{market.name}</span>
                      <span className="tile__note">Draws priced in {market.currency}</span>
                      <span className="tile__go" aria-hidden="true">
                        <ArrowIcon />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ----------------------------------------------------- competitions */}
      <section className="home-section" id="competitions" aria-labelledby="competitions-heading">
        <div className="container">
          <div className="section-intro">
            <p className="section-intro__eyebrow">
              <BottleIcon className="section-intro__icon" />
              <span className="eyebrow">Live competitions</span>
            </p>
            <h2 id="competitions-heading" className="section-intro__title">
              Iconic prizes. Real chances.
            </h2>
            <p className="section-intro__lede">
              Every competition below is open or opening soon, with its prizes, closing time and
              entry price shown before you enter.
            </p>
          </div>

          {!featured ? (
            <div className="empty-state" data-testid="no-draws">
              <h3>No competitions are open right now</h3>
              <p>
                New draws appear here as soon as they are published. Each one shows its prizes,
                closing time and entry price before you enter.
              </p>
            </div>
          ) : (
            <>
              {/* ------------------------------------------ featured composition */}
              <article className="feature" data-testid="featured-draw">
                <div className="feature__media">
                  <span className="feature__flag">Featured</span>
                  <PrizeArt title={featured.draw.headlinePrize ?? featured.draw.title} />
                </div>

                <div className="feature__body">
                  <div className="row-card__head">
                    <StatusBadge status={featured.draw.status} />
                    <span className="pill pill--quiet">
                      <GlobeIcon className="pill__icon" />
                      {featured.market.name}
                    </span>
                  </div>

                  <h3 className="feature__title">
                    <Link href={featuredHref}>{featured.draw.title}</Link>
                  </h3>

                  {featured.draw.headlinePrize && (
                    <p className="feature__prize">Top prize: {featured.draw.headlinePrize}</p>
                  )}

                  <dl className="feature__facts">
                    <div>
                      <dt>Entry</dt>
                      <dd className="price">
                        {formatPrice(
                          featured.draw.ticketPriceMinor,
                          featured.draw.currency,
                          featured.market.locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Tickets</dt>
                      <dd>{formatCount(featured.draw.totalTickets, featured.market.locale)}</dd>
                    </div>
                    <div>
                      <dt>{featured.draw.winnerPositions === 1 ? 'Winner' : 'Winner positions'}</dt>
                      <dd>{formatCount(featured.draw.winnerPositions, featured.market.locale)}</dd>
                    </div>
                  </dl>

                  {taken !== null && percent !== null && availability && (
                    <div className="meter">
                      <p className="meter__figures">
                        <strong>{formatCount(taken, featured.market.locale)}</strong> /{' '}
                        {formatCount(availability.total, featured.market.locale)} entries
                        <span className="meter__percent">{percent}%</span>
                      </p>
                      <div
                        className="meter__track"
                        role="progressbar"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="Entries taken"
                      >
                        <span className="meter__fill" style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  )}

                  <div className="feature__foot">
                    <DrawCountdown
                      to={
                        featured.draw.status === 'live'
                          ? featured.draw.closesAt
                          : featured.draw.opensAt
                      }
                      label={featured.draw.status === 'live' ? 'Draw ends in' : 'Draw opens in'}
                    />
                    <Link className="button button--blue" href={featuredHref}>
                      Enter now
                      <ArrowIcon className="button__arrow" />
                    </Link>
                  </div>
                </div>
              </article>

              {/* ------------------------------------------- secondary cards */}
              {secondary.length > 0 && (
                <ul className="row-grid" data-testid="home-draws">
                  {secondary.map(({ draw, market }) => (
                    <li key={`${market.code}/${draw.slug}`}>
                      <DrawRowCard draw={draw} market={market} />
                    </li>
                  ))}
                </ul>
              )}

              <nav className="market-links" aria-label="Competitions by market">
                {open.map((market) => (
                  <Link key={market.code} className="link-arrow" href={`/${market.code}/draws`}>
                    {open.length === 1
                      ? 'View all competitions'
                      : `All ${market.name} competitions`}{' '}
                    <span aria-hidden="true">→</span>
                  </Link>
                ))}
              </nav>
            </>
          )}
        </div>
      </section>

      {/* ------------------------------------------------- editorial banner */}
      <section className="home-section home-section--flush" aria-labelledby="discover-heading">
        <div className="container">
          <div className="banner">
            <DiamondIcon className="banner__icon" />
            <div className="banner__copy">
              <h2 id="discover-heading" className="banner__title">
                Discover the vault
              </h2>
              <p>
                Open and upcoming competitions, each with its prizes, its closing time and its rules
                in plain sight.
              </p>
            </div>
            <Link className="button button--sand" href={browseHref}>
              Explore competitions
              <ArrowIcon className="button__arrow" />
            </Link>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- how it works */}
      <section className="home-section" id="how-it-works" aria-labelledby="how-heading">
        <div className="container">
          <div className="rule-head">
            <h2 id="how-heading" className="rule-head__title">
              How it works
            </h2>
            <span className="rule-head__rule" aria-hidden="true" />
          </div>

          <ol className="flow">
            <li className="flow__step">
              <span className="flow__disc" aria-hidden="true">
                <ListIcon />
              </span>
              <h3 className="flow__title">
                <span className="flow__number">1.</span> Choose a market
              </h3>
              <p>Browse the competitions open in your market.</p>
            </li>
            <li className="flow__step">
              <span className="flow__disc" aria-hidden="true">
                <TicketIcon />
              </span>
              <h3 className="flow__title">
                <span className="flow__number">2.</span> Select a draw
              </h3>
              <p>Pick your prize and choose how many entries you want.</p>
            </li>
            <li className="flow__step">
              <span className="flow__disc" aria-hidden="true">
                <QuestionIcon />
              </span>
              <h3 className="flow__title">
                <span className="flow__number">3.</span> Answer and enter
              </h3>
              <p>Answer the skill question and pay securely at checkout.</p>
            </li>
            <li className="flow__step">
              <span className="flow__disc" aria-hidden="true">
                <TrophyIcon />
              </span>
              <h3 className="flow__title">
                <span className="flow__number">4.</span> Follow your order
              </h3>
              <p>Track your order and see the outcome when the draw is settled.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* --------------------------------------------------------- trust strip */}
      <section className="trust-strip" aria-labelledby="trust-heading">
        <div className="container">
          <h2 id="trust-heading" className="visually-hidden">
            What to expect
          </h2>
          <ul className="trust-strip__row" data-testid="trust-strip">
            <li>
              <ShieldIcon className="trust-strip__icon" />
              <span>
                <strong>Secure checkout</strong>
                Card details are never held by Highland Vault.
              </span>
            </li>
            <li>
              <QuestionIcon className="trust-strip__icon" />
              <span>
                <strong>A skill question</strong>
                Every entry answers one, checked by the server.
              </span>
            </li>
            <li>
              <ListIcon className="trust-strip__icon" />
              <span>
                <strong>Published rules</strong>
                Prizes, timings and limits shown before you enter.
              </span>
            </li>
            <li>
              <ClockIcon className="trust-strip__icon" />
              <span>
                <strong>Tickets held for you</strong>
                Your numbers are reserved the moment you add them.
              </span>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
