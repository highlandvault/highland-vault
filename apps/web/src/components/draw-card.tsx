import type { Market, PublicDrawSummary } from '@hv/contracts';
import Link from 'next/link';
import { isClosingSoon } from '@/lib/draw-listing';
import { formatDateTime, formatPrice, formatRelative } from '@/lib/format';
import { PrizeArt } from './prize-art';
import { StatusBadge } from './status-badge';

export function DrawCard({ draw, market }: { draw: PublicDrawSummary; market: Market }) {
  const timing =
    draw.status === 'scheduled'
      ? { label: 'Opens', iso: draw.opensAt }
      : { label: 'Closes', iso: draw.closesAt };
  // Presentation only. The API owns the status; this only decides whether the
  // card says the same thing a little more plainly (see `isClosingSoon`).
  const closingSoon = isClosingSoon(draw);
  return (
    <article
      className={`draw-card${closingSoon ? ' draw-card--closing' : ''}`}
      data-testid="draw-card"
    >
      <PrizeArt title={draw.headlinePrize ?? draw.title} />
      <div className="draw-card__body">
        <StatusBadge status={draw.status} />
        <h3 className="draw-card__title">
          <Link href={`/${market.code}/draws/${draw.slug}`}>{draw.title}</Link>
        </h3>
        {draw.headlinePrize && <p className="draw-card__prize">Top prize: {draw.headlinePrize}</p>}
        {/* Its own line rather than a tail on the prize, so a draw with no
            headline prize still says how many people can win it. */}
        {draw.winnerPositions > 1 && (
          <p className="draw-card__winners" data-testid="draw-winners">
            {draw.winnerPositions} winner positions
          </p>
        )}
        <div className="draw-card__meta">
          <span className={closingSoon ? 'draw-card__timing draw-card__timing--soon' : undefined}>
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
