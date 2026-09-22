import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { fetchMarket } from '@/markets';

// Market availability can change at any time (admin gate changes), so render per request.
export const dynamic = 'force-dynamic';

/**
 * Every /{market}/… page sits behind this layout. If the API does not serve
 * the market — unknown, disabled, or excluded by ENABLED_MARKETS, as Germany
 * is today — the whole subtree is a 404.
 */
export default async function MarketLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ market: string }>;
}) {
  const market = await fetchMarket((await params).market);
  if (!market) notFound();
  return (
    <>
      <div className="market-bar">
        <div className="container market-bar__inner">
          <span>
            <Link href={`/${market.code}`}>{market.name}</Link> · prices in {market.currency}
          </span>
          <Link href={`/${market.code}/draws`}>All draws</Link>
        </div>
      </div>
      <main id="main" className="site-main">
        <div className="container">{children}</div>
      </main>
    </>
  );
}
