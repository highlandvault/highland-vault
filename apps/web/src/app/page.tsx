import type { Market, PublicDrawSummary } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DrawCard } from '@/components/draw-card';
import { VaultEmblem } from '@/components/vault-emblem';
import { fetchDraws } from '@/lib/draws';
import { fetchMarkets } from '@/markets';

export const metadata: Metadata = {
  title: { absolute: 'Highland Vault — exceptional prizes, one fair draw' },
  description:
    'Carefully selected prize draws with transparent entry, clear rules and a simple way to play.',
};

// Rendered per request: which markets are open, and which draws are live in
// them, are both facts about right now.
export const dynamic = 'force-dynamic';

/** How many draws the homepage shows before sending people to a market listing. */
const FEATURED = 6;

type Featured = { draw: PublicDrawSummary; market: Market };

/**
 * The draws worth putting on the front page, across every open market.
 *
 * There is no cross-market draw endpoint and inventing one is backend work, so
 * the markets are asked in parallel and their answers merged. Live draws come
 * first because they are the ones that can be entered; a market whose listing
 * fails contributes nothing rather than failing the page, which is the right
 * trade for a homepage.
 */
async function featuredDraws(markets: Market[]): Promise<Featured[]> {
  const perMarket = await Promise.all(
    markets.map(async (market) => {
      const result = await fetchDraws(market.code);
      return result.ok ? result.draws.map((draw) => ({ draw, market })) : [];
    }),
  );
  const all = perMarket.flat();
  const rank = (status: string) => (status === 'live' ? 0 : status === 'scheduled' ? 1 : 2);
  return all
    .filter(({ draw }) => draw.status === 'live' || draw.status === 'scheduled')
    .sort(
      (a, b) =>
        rank(a.draw.status) - rank(b.draw.status) ||
        Date.parse(a.draw.closesAt) - Date.parse(b.draw.closesAt),
    )
    .slice(0, FEATURED);
}

export default async function HomePage() {
  const markets = await fetchMarkets();
  const featured = markets && markets.length > 0 ? await featuredDraws(markets) : [];
  const open = markets ?? [];
  // With one market there is somewhere definite to send people; with several
  // the choice belongs to them, and it is made in the section below.
  const browseHref = open.length === 1 ? `/${open[0]!.code}/draws` : '#competitions';

  return (
    <main id="main" className="home">
      {/* ------------------------------------------------------------- hero */}
      <section className="home-hero">
        <div className="container home-hero__inner">
          <div className="home-hero__copy">
            <span className="eyebrow">Highland Vault</span>
            <h1 className="home-hero__title">
              Exceptional prizes.
              <br />
              One fair draw.
            </h1>
            <p className="home-hero__lede">
              Discover carefully selected prize draws with transparent entry, clear rules and a
              simple way to play.
            </p>
            <div className="cta-row">
              <Link className="button button--gold" href={browseHref}>
                Explore competitions
              </Link>
              <Link className="button button--ghost" href="#how-it-works">
                How it works
              </Link>
            </div>
          </div>
          <div className="home-hero__art">
            <VaultEmblem />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- competitions */}
      <section className="home-section" id="competitions" aria-labelledby="competitions-heading">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">Live now</span>
              <h2 id="competitions-heading">Enter the next draw.</h2>
            </div>
            <p>Explore current competitions and find something worth opening the vault for.</p>
          </div>

          {markets === null ? (
            <p className="notice notice--danger" role="alert" data-testid="home-unavailable">
              Competitions could not be loaded right now. Please try again shortly.
            </p>
          ) : featured.length === 0 ? (
            <div className="empty-state" data-testid="no-draws">
              <h3>No competitions are open right now</h3>
              <p>
                New draws appear here as soon as they are published. Each one shows its prizes,
                closing time and entry price before you enter.
              </p>
            </div>
          ) : (
            <ul className="draw-grid" data-testid="home-draws">
              {featured.map(({ draw, market }) => (
                <li key={`${market.code}/${draw.slug}`}>
                  <DrawCard draw={draw} market={market} />
                </li>
              ))}
            </ul>
          )}

          {open.length > 0 && (
            <nav className="market-links" aria-label="Competitions by market" data-testid="markets">
              {open.map((market) => (
                <Link key={market.code} className="link-arrow" href={`/${market.code}/draws`}>
                  {open.length === 1 ? 'View all competitions' : `All ${market.name} competitions`}{' '}
                  <span aria-hidden="true">→</span>
                  <span className="visually-hidden"> (prices in {market.currency})</span>
                </Link>
              ))}
            </nav>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="home-section home-section--tint" id="how-it-works" aria-labelledby="how">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">How it works</span>
              <h2 id="how">Three steps, start to finish.</h2>
            </div>
          </div>
          <ol className="steps">
            <li className="step">
              <span className="step__number" aria-hidden="true">
                01
              </span>
              <h3 className="step__title">Choose your draw</h3>
              <p>Browse the competitions currently available in your market.</p>
            </li>
            <li className="step">
              <span className="step__number" aria-hidden="true">
                02
              </span>
              <h3 className="step__title">Answer and enter</h3>
              <p>Complete the skill question and select your entries.</p>
            </li>
            <li className="step">
              <span className="step__number" aria-hidden="true">
                03
              </span>
              <h3 className="step__title">Check your result</h3>
              <p>Follow your order and see the outcome when the draw is settled.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------ trust */}
      <section className="home-section" aria-labelledby="principles">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">What to expect</span>
              <h2 id="principles">Built to be read, not decoded.</h2>
            </div>
          </div>
          <ul className="principles">
            <li className="principle">
              <h3 className="principle__title">Clear entry</h3>
              <p>
                Straightforward pricing and entry information. Every draw shows its entry price, the
                number of tickets and the limit per person before you enter.
              </p>
            </li>
            <li className="principle">
              <h3 className="principle__title">Transparent draws</h3>
              <p>
                Clear draw details and published rules. Prizes, opening and closing times and the
                number of winners are shown on every competition.
              </p>
            </li>
            <li className="principle">
              <h3 className="principle__title">Secure checkout</h3>
              <p>
                Payment is handled through the platform&rsquo;s secure checkout. Card details are
                never held by Highland Vault.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* -------------------------------------------------------- final CTA */}
      <section className="home-close" aria-labelledby="close">
        <div className="container home-close__inner">
          <span className="eyebrow">The vault is open</span>
          <h2 id="close">Find your next prize.</h2>
          <Link className="button button--gold" href={browseHref}>
            Explore competitions
          </Link>
        </div>
      </section>
    </main>
  );
}
