import Link from 'next/link';
import { fetchMarkets } from '@/markets';
import { ApiStatus } from './api-status';

// Rendered per request so the API status and market availability are live.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const markets = await fetchMarkets();
  return (
    <>
      <h1>Development shell</h1>
      <p>No customer features exist yet.</p>
      <section aria-labelledby="markets">
        <h2 id="markets">Available markets</h2>
        {markets === null ? (
          <p>Market list unavailable.</p>
        ) : markets.length === 0 ? (
          <p data-testid="no-markets">
            No market is enabled. Markets stay disabled until their compliance settings are decided
            (OPEN O12).
          </p>
        ) : (
          <ul data-testid="market-list">
            {markets.map((market) => (
              <li key={market.code}>
                <Link href={`/${market.code}`}>/{market.code}</Link> — {market.name} (
                {market.currency})
              </li>
            ))}
          </ul>
        )}
      </section>
      <ApiStatus />
    </>
  );
}
