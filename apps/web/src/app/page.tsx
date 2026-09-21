import Link from 'next/link';
import { WEB_MARKETS, type WebMarketCode } from '@/markets';
import { ApiStatus } from './api-status';

// Rendered per request so the API status is live.
export const dynamic = 'force-dynamic';

export default function HomePage() {
  const markets = Object.entries(WEB_MARKETS) as [
    WebMarketCode,
    (typeof WEB_MARKETS)[WebMarketCode],
  ][];
  return (
    <>
      <h1>Development shell</h1>
      <p>No customer features exist yet. Markets available for routing:</p>
      <ul>
        {markets.map(([code, market]) => (
          <li key={code}>
            <Link href={`/${code}`}>/{code}</Link> — {market.name} ({market.currency})
          </li>
        ))}
      </ul>
      <ApiStatus />
    </>
  );
}
