import type { Market, PublicDrawSummary } from '@hv/contracts';
import Link from 'next/link';
import { formatDateTime, formatPrice, formatRelative } from '@/lib/format';
import { PrizeArt } from './prize-art';
import { StatusBadge } from './status-badge';

export function DrawCard({ draw, market }: { draw: PublicDrawSummary; market: Market }) {
  const timing =
    draw.status === 'scheduled'
      ? { label: 'Opens', iso: draw.opensAt }
      : { label: 'Closes', iso: draw.closesAt };
  return (
    <article className="draw-card" data-testid="draw-card">
      <PrizeArt title={draw.headlinePrize ?? draw.title} />
      <div className="draw-card__body">
        <StatusBadge status={draw.status} />
        <h3 className="draw-card__title">
          <Link href={`/${market.code}/draws/${draw.slug}`}>{draw.title}</Link>
        </h3>
        {draw.headlinePrize && (
          <p className="draw-card__prize">
            Top prize: {draw.headlinePrize}
            {draw.winnerPositions > 1 ? ` · ${draw.winnerPositions} winners` : ''}
          </p>
        )}
        <div className="draw-card__meta">
          <span>
            {timing.label} {formatRelative(timing.iso, market.locale)}
            <br />
            <time dateTime={timing.iso}>
              {formatDateTime(timing.iso, market.locale, market.code)}
            </time>
          </span>
          <span className="price">
            {formatPrice(draw.ticketPriceMinor, draw.currency, market.locale)}
            <small> / entry</small>
          </span>
        </div>
      </div>
    </article>
  );
}
