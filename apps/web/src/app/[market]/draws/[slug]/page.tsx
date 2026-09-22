import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EntryPanel } from '@/components/entry-panel';
import { PrizeArt } from '@/components/prize-art';
import { StatusBadge } from '@/components/status-badge';
import { fetchDraw } from '@/lib/draws';
import { formatCount, formatDateTime, formatPrice, formatRelative, ordinal } from '@/lib/format';
import { fetchMarket } from '@/markets';

type Params = Promise<{ market: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { market, slug } = await params;
  const draw = await fetchDraw(market, slug).catch(() => null);
  return { title: draw?.title ?? 'Draw' };
}

export default async function DrawDetailPage({ params }: { params: Params }) {
  const { market: code, slug } = await params;
  const market = await fetchMarket(code);
  if (!market) notFound();
  // Unknown, unpublished, cancelled or another market's draw: all 404.
  const draw = await fetchDraw(market.code, slug);
  if (!draw) notFound();

  const when = (iso: string) => formatDateTime(iso, market.locale, market.code);
  const price = formatPrice(draw.ticketPriceMinor, draw.currency, market.locale);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> ›{' '}
        <Link href={`/${market.code}/draws`}>Draws</Link> › {draw.title}
      </nav>

      <div className="detail">
        <div className="stack">
          <PrizeArt title={draw.prizes[0]?.title ?? draw.title} />
          <div>
            <StatusBadge status={draw.status} />
            <h1 data-testid="draw-title" style={{ marginTop: 12 }}>
              {draw.title}
            </h1>
            {draw.description && <p className="prose">{draw.description}</p>}
          </div>

          <section className="panel" aria-labelledby="prizes">
            <h2 id="prizes">
              {draw.prizes.length === 1 ? 'The prize' : `${draw.prizes.length} prizes`}
            </h2>
            <ol className="prize-list" data-testid="prize-list">
              {draw.prizes.map((prize) => (
                <li key={prize.position}>
                  <span className="prize-rank" aria-label={`${ordinal(prize.position)} prize`}>
                    {ordinal(prize.position)}
                  </span>
                  <div>
                    <h3>{prize.title}</h3>
                    {prize.description && <p>{prize.description}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="detail__aside" aria-label="Entry">
          <div className="panel">
            <dl className="facts" data-testid="draw-facts">
              <div>
                <dt>Entry price</dt>
                <dd className="price">{price}</dd>
              </div>
              <div>
                <dt>
                  {draw.status === 'scheduled'
                    ? 'Opens'
                    : draw.status === 'live'
                      ? 'Closes'
                      : 'Closed'}
                </dt>
                <dd>
                  {formatRelative(
                    draw.status === 'scheduled' ? draw.opensAt : draw.closesAt,
                    market.locale,
                  )}
                </dd>
              </div>
              <div>
                <dt>Opens</dt>
                <dd>
                  <time dateTime={draw.opensAt}>{when(draw.opensAt)}</time>
                </dd>
              </div>
              <div>
                <dt>Closes</dt>
                <dd>
                  <time dateTime={draw.closesAt} data-testid="draw-closes">
                    {when(draw.closesAt)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Tickets in this draw</dt>
                <dd>{formatCount(draw.totalTickets, market.locale)}</dd>
              </div>
              <div>
                <dt>Maximum per person</dt>
                <dd>{formatCount(draw.maxPerPerson, market.locale)}</dd>
              </div>
            </dl>
          </div>
          <div className="panel">
            <EntryPanel
              status={draw.status}
              currency={draw.currency}
              locale={market.locale}
              ticketPriceMinor={draw.ticketPriceMinor}
              maxPerPerson={draw.maxPerPerson}
              skillQuestion={draw.skillQuestion}
            />
          </div>
        </aside>
      </div>
    </>
  );
}
