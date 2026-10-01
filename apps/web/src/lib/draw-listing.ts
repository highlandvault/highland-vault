import type { PublicDrawSummary } from '@hv/contracts';

/**
 * Filtering, sorting and searching for the competition listing.
 *
 * **All of it happens here, after the API has answered.** The listing endpoint
 * takes no query string at all — `GET /markets/:market/draws` validates its
 * query against an empty object and answers 422 for anything else — so the
 * page asks for the market's draws once and arranges them itself. Nothing in
 * this file reaches the network, and nothing in it decides what a customer is
 * allowed to see: the API has already applied the market gate and the
 * publication rules, and a draw that is not in its answer cannot be conjured
 * up by a filter.
 *
 * Not `server-only`: it holds no secret and touches no request, which also
 * lets it be unit tested directly.
 */

/** How the results are ordered. `featured` is the API's own order. */
export const SORTS = [
  { value: 'featured', label: 'Featured' },
  { value: 'closing-soon', label: 'Closing soonest' },
  { value: 'opening-soon', label: 'Opening soonest' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'winners', label: 'Most winner positions' },
] as const;

export type Sort = (typeof SORTS)[number]['value'];

export const STATUSES = [
  { value: 'all', label: 'All competitions' },
  { value: 'open', label: 'Open now' },
  { value: 'upcoming', label: 'Opening soon' },
] as const;

export type StatusFilter = (typeof STATUSES)[number]['value'];

export interface ListingQuery {
  readonly q: string;
  readonly status: StatusFilter;
  readonly sort: Sort;
}

export const DEFAULT_QUERY: ListingQuery = { q: '', status: 'all', sort: 'featured' };

/** Longer than any sensible title; anything beyond is a mistake or an attack. */
const MAX_SEARCH = 80;

function one(value: string | string[] | undefined): string {
  // `?q=a&q=b` arrives as an array. The last one wins, which is what a form
  // resubmission looks like, rather than refusing a URL somebody can produce
  // by accident.
  if (Array.isArray(value)) return value[value.length - 1] ?? '';
  return value ?? '';
}

/**
 * Reads the query string, and never throws.
 *
 * A URL is typed, shared, truncated and edited by hand. An unknown sort or a
 * status that does not exist is not an error worth a 500 or even a message —
 * it falls back to the default view, which is a page that works. Validation
 * here is about producing a known-good state, not about refusing input.
 */
export function parseListingQuery(
  searchParams: Record<string, string | string[] | undefined>,
): ListingQuery {
  const sort = one(searchParams.sort);
  const status = one(searchParams.status);
  return {
    q: one(searchParams.q).trim().slice(0, MAX_SEARCH),
    status: STATUSES.some((s) => s.value === status) ? (status as StatusFilter) : 'all',
    sort: SORTS.some((s) => s.value === sort) ? (sort as Sort) : 'featured',
  };
}

/** Whether the customer has asked for anything other than the default view. */
export function isFiltered(query: ListingQuery): boolean {
  return query.q !== '' || query.status !== 'all' || query.sort !== 'featured';
}

/**
 * Grouped into "Open now" and "Opening soon", or one flat grid.
 *
 * Grouping and sorting are the same job done twice, and doing both at once
 * produces a page that claims to be sorted by price while price runs down the
 * screen twice. So an explicit sort — or a status filter that leaves one group
 * anyway — collapses the sections.
 */
export function isGrouped(query: ListingQuery): boolean {
  return query.sort === 'featured' && query.status === 'all';
}

function matchesStatus(draw: PublicDrawSummary, status: StatusFilter): boolean {
  if (status === 'open') return draw.status === 'live';
  if (status === 'upcoming') return draw.status === 'scheduled';
  return true;
}

function matchesSearch(draw: PublicDrawSummary, q: string): boolean {
  if (q === '') return true;
  // Title only. The list payload carries no description, and searching a field
  // that is not there would quietly find nothing.
  return draw.title.toLowerCase().includes(q.toLowerCase());
}

const COMPARATORS: Record<Sort, (a: PublicDrawSummary, b: PublicDrawSummary) => number> = {
  // The API returns live first by soonest close, then scheduled by soonest
  // open. That order is deliberate and is left exactly as it arrived.
  featured: () => 0,
  'closing-soon': (a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt),
  'opening-soon': (a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt),
  'price-asc': (a, b) => a.ticketPriceMinor - b.ticketPriceMinor,
  'price-desc': (a, b) => b.ticketPriceMinor - a.ticketPriceMinor,
  winners: (a, b) => b.winnerPositions - a.winnerPositions,
};

/**
 * The draws to show, in the order to show them.
 *
 * Stable: ties keep the API's order, so two draws at the same price do not
 * swap places between one render and the next.
 */
export function applyListing(
  draws: readonly PublicDrawSummary[],
  query: ListingQuery,
): PublicDrawSummary[] {
  const matched = draws.filter(
    (draw) => matchesStatus(draw, query.status) && matchesSearch(draw, query.q),
  );
  const compare = COMPARATORS[query.sort];
  // `Array.prototype.sort` is stable in every engine this runs on, so a
  // comparator returning 0 preserves the incoming order.
  return matched.slice().sort(compare);
}

/** How near closing counts as near. Long enough to be useful, short enough to mean something. */
export const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * Presentation only, and only for a draw the API already calls live.
 *
 * The API owns what a draw's status is — `effectiveStatus` recomputes it on
 * every read because the lifecycle sweeper runs about once a minute — and
 * nothing here may contradict it. This answers a smaller question: should the
 * card say so a little more loudly. A draw that has passed its closing time is
 * not "closing soon"; it is closed, and the next read from the API will say so.
 */
export function isClosingSoon(draw: PublicDrawSummary, now = Date.now()): boolean {
  if (draw.status !== 'live') return false;
  const remaining = Date.parse(draw.closesAt) - now;
  return remaining > 0 && remaining <= CLOSING_SOON_MS;
}

/** Counts for the header summary, taken from whatever is actually being shown. */
export function summarise(draws: readonly PublicDrawSummary[]): {
  total: number;
  open: number;
  upcoming: number;
} {
  return {
    total: draws.length,
    open: draws.filter((d) => d.status === 'live').length,
    upcoming: draws.filter((d) => d.status === 'scheduled').length,
  };
}
