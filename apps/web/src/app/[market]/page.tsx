import { notFound } from 'next/navigation';
import { WEB_MARKETS, isWebMarket } from '@/markets';

export function generateStaticParams() {
  return Object.keys(WEB_MARKETS).map((market) => ({ market }));
}

// uk/ie are prerendered; any other segment (including /de while Germany is gated) is a 404.
export default async function MarketHomePage({ params }: { params: Promise<{ market: string }> }) {
  const { market } = await params;
  if (!isWebMarket(market)) notFound();
  const config = WEB_MARKETS[market];
  return (
    <>
      <h1 data-testid="market-heading">{config.name}</h1>
      <p>
        Market shell for /{market} — locale {config.locale}, currency {config.currency}. Draws
        arrive in Phase 3.
      </p>
    </>
  );
}
