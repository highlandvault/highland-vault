import type { Market, PublicDrawSummary } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DrawCard } from '@/components/draw-card';
import {
  applyListing,
  isFiltered,
  isGrouped,
  parseListingQuery,
  summarise,
} from '@/lib/draw-listing';
import { fetchDraws } from '@/lib/draws';
import { fetchMarket } from '@/markets';
import { ListingToolbar } from './toolbar';

/**
 * The competition listing.
 *
 * ## Why there is no `loading.tsx`
 *
 * There was one, and it broke the page for anybody without JavaScript. A
 * `loading.tsx` wraps the segment in Suspense; the page is async, so it
 * suspends, the shell streams with the skeleton in it, and the real content
 * arrives afterwards to be swapped in **by the client runtime**. With
 * scripting off, `/uk/draws` rendered the words "Loading draws…" and nothing
 * else — while the market home and the draw detail, which have no such
 * boundary, rendered in full.
 *
 * That was true before this page had a toolbar, and it is not a defect in the
 * toolbar. But the toolbar is a plain GET form whose entire point is working
 * without JavaScript, and a control bar that submits into a page that cannot
 * render is not worth having. The skeleton was the smaller of the two things.
 *
 * The `(list)` route group is kept: it is what stopped the boundary applying
 * to `[slug]`, where streaming would have turned the detail page's 404s into
 * 200s. If the skeleton is ever wanted back, it belongs here and nowhere else.
 */
type Params = Promise<{ market: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const market = await fetchMarket((await params).market);
  // Indexing stays off globally (root layout); this only improves the title a
  // reader sees in a tab or a shared link.
  return market
    ? {
        title: `Competitions in ${market.name}`,
        description: `Prize draws open now and opening soon in ${market.name}, with prices in ${market.currency}.`,
      }
    : { title: 'Competitions' };
}

/** The draws to put under each heading in the default, grouped view. */
function grouped(draws: readonly PublicDrawSummary[]) {
  return {
    open: draws.filter((d) => d.status === 'live'),
    upcoming: draws.filter((d) => d.status === 'scheduled'),
  };
}

function Grid({
  draws,
  market,
  testId,
}: {
  draws: readonly PublicDrawSummary[];
  market: Market;
  testId: string;
}) {
  return (
    <ul className="draw-grid" data-testid={testId}>
      {draws.map((draw) => (
        <li key={draw.slug}>
          <DrawCard draw={draw} market={market} />
        </li>
      ))}
    </ul>
  );
}

export default async function DrawListPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const market = await fetchMarket((await params).market);
  if (!market) notFound();
  const query = parseListingQuery(await searchParams);

  // One request, whatever the customer asked for. The listing endpoint takes
  // no query string (it validates against an empty object), and the market
  // gate and publication rules are applied inside it — so everything below is
  // arrangement, never permission.
  const result = await fetchDraws(market.code);
  // A failed load goes to the error boundary (error.tsx) with a retry.
  if (!result.ok) throw new Error(`Draws unavailable: ${result.reason}`);

  const shown = applyListing(result.draws, query);
  const counts = summarise(shown);
  const filtered = isFiltered(query);
  const listingPath = `/${market.code}/draws`;

  const parts = [`${counts.total} ${counts.total === 1 ? 'competition' : 'competitions'}`];
  if (counts.open > 0) parts.push(`${counts.open} open`);
  if (counts.upcoming > 0) parts.push(`${counts.upcoming} opening soon`);
  const resultLabel = parts.join(' · ');

  const sections = grouped(shown);
  const showGroups = isGrouped(query);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href={`/${market.code}`}>{market.name}</Link> › Competitions
      </nav>

      {/* The market is named in the eyebrow and the breadcrumb, and never
          inside a preposition — "in Ireland" is right and "in United Kingdom"
          is not, and the API supplies the name without an article. */}
      <header className="listing-head">
        <div>
          <span className="eyebrow">{market.name}</span>
          <h1>Competitions worth entering.</h1>
        </div>
        <p className="listing-head__lede">
          Every draw shows its prizes, closing time and entry price before you enter. Prices are in{' '}
          {market.currency}, and every entry includes a skill question.
        </p>
      </header>

      <ListingToolbar
        action={listingPath}
        query={query}
        filtered={filtered}
        resultLabel={resultLabel}
      />

      {result.draws.length === 0 ? (
        /* A. Nothing published in this market at all. */
        <div className="empty-state" data-testid="no-draws">
          <h2>No competitions are available right now</h2>
          <p>
            {market.name} has no open or upcoming draws at the moment. New draws appear here as soon
            as they are published.
          </p>
        </div>
      ) : shown.length === 0 ? (
        /* B. There are draws; this view does not match any of them. */
        <div className="empty-state" data-testid="no-matches">
          <h2>No competitions match your current filters</h2>
          <p>
            {result.draws.length === 1
              ? 'There is one competition in this market.'
              : `There are ${result.draws.length} competitions in this market.`}{' '}
            Try a different search, or start again.
          </p>
          <Link className="button button--outline" href={listingPath}>
            Clear filters
          </Link>
        </div>
      ) : showGroups ? (
        <div className="stack">
          {sections.open.length > 0 ? (
            <section aria-labelledby="open-draws-heading">
              <h2 id="open-draws-heading">Open now</h2>
              <Grid draws={sections.open} market={market} testId="open-draws" />
            </section>
          ) : (
            /* C. Nothing open, but something is coming. Saying "no draws"
                  here would be false, and the upcoming section is right below. */
            <p className="notice" data-testid="no-open-draws">
              No competitions are open at the moment.{' '}
              {sections.upcoming.length === 1
                ? 'One is opening soon.'
                : `${sections.upcoming.length} are opening soon.`}
            </p>
          )}
          {sections.upcoming.length > 0 && (
            <section aria-labelledby="upcoming-draws-heading">
              <h2 id="upcoming-draws-heading">Opening soon</h2>
              <Grid draws={sections.upcoming} market={market} testId="upcoming-draws" />
            </section>
          )}
        </div>
      ) : (
        /* Sorted or filtered: one grid, because grouping by status while
           sorting by price runs the price down the screen twice. */
        <section aria-labelledby="results-heading">
          <h2 id="results-heading" className="visually-hidden">
            Results
          </h2>
          <Grid draws={shown} market={market} testId="draw-results" />
        </section>
      )}
    </>
  );
}
