import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DrawCard } from '@/components/draw-card';
import { fetchDraws } from '@/lib/draws';
import { fetchMarket } from '@/markets';

export const metadata: Metadata = { title: 'Draws' };

export default async function DrawListPage({ params }: { params: Promise<{ market: string }> }) {
  const market = await fetchMarket((await params).market);
  if (!market) notFound();
  const result = await fetchDraws(market.code);
  // A failed load goes to the error boundary (error.tsx) with a retry.
  if (!result.ok) throw new Error(`Draws unavailable: ${result.reason}`);

  const open = result.draws.filter((d) => d.status === 'live');
  const upcoming = result.draws.filter((d) => d.status === 'scheduled');

  return (
    <>
      <div className="section-head">
        <div>
          <span className="eyebrow">{market.name}</span>
          <h1>Draws</h1>
        </div>
        <p>Prices in {market.currency}. Every entry includes a skill question.</p>
      </div>

      {result.draws.length === 0 ? (
        <div className="empty-state" data-testid="no-draws">
          <h2>No draws right now</h2>
          <p>
            There are no open or upcoming draws in {market.name}. New draws appear here as soon as
            they are published.
          </p>
        </div>
      ) : (
        <div className="stack">
          {open.length > 0 && (
            <section aria-labelledby="open-draws">
              <h2 id="open-draws">Open now</h2>
              <ul className="draw-grid" data-testid="open-draws">
                {open.map((draw) => (
                  <li key={draw.slug}>
                    <DrawCard draw={draw} market={market} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {upcoming.length > 0 && (
            <section aria-labelledby="upcoming-draws">
              <h2 id="upcoming-draws">Opening soon</h2>
              <ul className="draw-grid" data-testid="upcoming-draws">
                {upcoming.map((draw) => (
                  <li key={draw.slug}>
                    <DrawCard draw={draw} market={market} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
