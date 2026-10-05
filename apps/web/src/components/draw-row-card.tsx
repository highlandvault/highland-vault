import type { Market, PublicDrawSummary } from '@hv/contracts';
import Link from 'next/link';
import { DrawCountdown } from './draw-countdown';
import { ArrowIcon } from './icons';
import { PrizeArt } from './prize-art';
import { StatusBadge } from './status-badge';
import { formatDateTime, formatPrice } from '@/lib/format';

/**
 * A draw as a wide row: artwork on the left, everything else on the right.
 *
 * Deliberately not `DrawCard`. That one is a portrait tile built for a grid
 * and its whole shape — 16:9 art above a stacked body — is what makes the grid
 * work; forcing it sideways would mean overriding almost every rule it has.
 * Two presentations of the same data is the honest answer, and both read the
 * same `PublicDrawSummary`, so there is still one source for what a draw is.
 *
 * The exact closing time is always present as a `<time>` beside the countdown,
 * so the card is complete before hydration and stays complete after the
 * deadline passes.
 */
export function DrawRowCard({ draw, market }: { draw: PublicDrawSummary; market: Market }) {
  const href = `/${market.code}/draws/${draw.slug}`;
  const live = draw.status === 'live';
  const timing = live ? draw.closesAt : draw.opensAt;

  return (
    <article className="row-card" data-testid="row-card">
      <div className="row-card__media">
        <PrizeArt title={draw.headlinePrize ?? draw.title} />
      </div>

      <div className="row-card__body">
        <div className="row-card__head">
          <StatusBadge status={draw.status} />
          {draw.winnerPositions > 1 && (
            <span className="row-card__winners">{draw.winnerPositions} winner positions</span>
          )}
        </div>

        <h3 className="row-card__title">
          <Link href={href}>{draw.title}</Link>
        </h3>

        {draw.headlinePrize && <p className="row-card__prize">{draw.headlinePrize}</p>}

        <div className="row-card__meta">
          <span className="price">
            {formatPrice(draw.ticketPriceMinor, draw.currency, market.locale)}
            <small> per entry</small>
          </span>
          <DrawCountdown to={timing} label={live ? 'Ends in' : 'Opens in'} />
        </div>

        <p className="row-card__when">
          <time dateTime={timing}>{formatDateTime(timing, market.locale, market.code)}</time>
        </p>

        {/* The whole card is already clickable through the title; this is the
            visible affordance, and it is not a second tab stop. */}
        <span className="button button--blue row-card__cta" aria-hidden="true">
          {live ? 'Enter now' : 'View draw'}
          <ArrowIcon className="button__arrow" />
        </span>
      </div>
    </article>
  );
}
