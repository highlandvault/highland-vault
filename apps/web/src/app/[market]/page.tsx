import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DrawCard } from '@/components/draw-card';
import { fetchDraws } from '@/lib/draws';
import { fetchMarket } from '@/markets';

const FEATURED = 3;

export default async function MarketHomePage({ params }: { params: Promise<{ market: string }> }) {
  const market = await fetchMarket((await params).market);
  if (!market) notFound();
  const result = await fetchDraws(market.code);
  const featured = result.ok ? result.draws.slice(0, FEATURED) : [];

  return (
    <>
      <section className="hero">
        <span className="eyebrow">Highland Vault · {market.name}</span>
        <h1 data-testid="market-heading">{market.name}</h1>
        <p>
          Prize draws for {market.name}. Every entry includes a skill question, and every draw shows
          its prizes, closing time and entry price up front.
        </p>
        <Link className="button button--gold" href={`/${market.code}/draws`}>
          Browse draws
        </Link>
      </section>

      <section aria-labelledby="featured">
        <div className="section-head">
          <h2 id="featured">Open and upcoming</h2>
          <Link className="link-arrow" href={`/${market.code}/draws`}>
            View all draws →
          </Link>
        </div>
        {!result.ok ? (
          <p className="notice notice--danger" role="alert">
            Draws could not be loaded right now. Please try again shortly.
          </p>
        ) : featured.length === 0 ? (
          <div className="empty-state" data-testid="no-draws">
            <h3>No draws right now</h3>
            <p>There are no open or upcoming draws in {market.name} at the moment.</p>
          </div>
        ) : (
          <ul className="draw-grid">
            {featured.map((draw) => (
              <li key={draw.slug}>
                <DrawCard draw={draw} market={market} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
