import { notFound } from 'next/navigation';
import { fetchMarket } from '@/markets';

// Market availability can change at any time (admin gate changes), so render per request.
export const dynamic = 'force-dynamic';

// The API decides: unknown, disabled or environment-excluded markets (including
// /de while Germany is gated) are all a 404 here.
export default async function MarketHomePage({ params }: { params: Promise<{ market: string }> }) {
  const { market: segment } = await params;
  const market = await fetchMarket(segment);
  if (!market) notFound();
  return (
    <>
      <h1 data-testid="market-heading">{market.name}</h1>
      <p>
        Market shell for /{market.code} — locale {market.locale}, currency {market.currency}. Draws
        arrive in Phase 3.
      </p>
    </>
  );
}
