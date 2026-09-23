import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { fetchMarkets } from '@/markets';
import { ApiStatus } from './api-status';

// Rendered per request so the API status and market availability are live.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const markets = await fetchMarkets();
  return (
    <PageShell>
      <section className="hero">
        <span className="eyebrow">Highland Vault</span>
        <h1>Prize draws, done properly.</h1>
        <p>Choose your market to see its draws, prizes and closing times.</p>
      </section>

      <section aria-labelledby="markets">
        <div className="section-head">
          <h2 id="markets">Choose your market</h2>
        </div>
        {markets === null ? (
          <p className="notice notice--danger" role="alert">
            Markets could not be loaded right now.
          </p>
        ) : markets.length === 0 ? (
          <div className="empty-state" data-testid="no-markets">
            <h3>No market is open yet</h3>
            <p>Markets stay closed until their compliance settings are decided (OPEN O12).</p>
          </div>
        ) : (
          <ul className="draw-grid" data-testid="market-list">
            {markets.map((market) => (
              <li key={market.code}>
                <article className="draw-card">
                  <div className="draw-card__body">
                    <span className="eyebrow" style={{ marginBottom: 0 }}>
                      {market.currency}
                    </span>
                    <h3 className="draw-card__title">
                      <Link href={`/${market.code}`}>{market.name}</Link>
                    </h3>
                    <p className="draw-card__prize">
                      /{market.code} — {market.name} ({market.currency})
                    </p>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 40 }}>
        <ApiStatus />
      </section>
    </PageShell>
  );
}
