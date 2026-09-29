import type { PublicDrawSummary } from '@hv/contracts';
import { describe, expect, it } from 'vitest';
import {
  CLOSING_SOON_MS,
  DEFAULT_QUERY,
  applyListing,
  isClosingSoon,
  isFiltered,
  isGrouped,
  parseListingQuery,
  summarise,
} from './draw-listing';

/**
 * The listing's arithmetic, away from the page.
 *
 * Most of this is about what happens to a URL somebody edited: the query
 * string is the only input here that arrives from outside, and every one of
 * these cases has to produce a page rather than an error.
 */

const HOUR = 60 * 60 * 1000;
let n = 0;

function draw(over: Partial<PublicDrawSummary> = {}): PublicDrawSummary {
  const i = n++;
  return {
    slug: `draw-${i}`,
    title: `Draw ${i}`,
    status: 'live',
    currency: 'GBP',
    ticketPriceMinor: 500,
    totalTickets: 100,
    maxPerPerson: 10,
    winnerPositions: 1,
    opensAt: new Date(Date.now() - HOUR).toISOString(),
    closesAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    headlinePrize: null,
    ...over,
  };
}

describe('reading the query string', () => {
  it('defaults everything when nothing is asked for', () => {
    expect(parseListingQuery({})).toEqual(DEFAULT_QUERY);
  });

  it('accepts every sort and status it offers', () => {
    expect(parseListingQuery({ sort: 'price-desc', status: 'upcoming' })).toEqual({
      q: '',
      status: 'upcoming',
      sort: 'price-desc',
    });
  });

  it('falls back rather than throwing on values it does not know', () => {
    // A URL is typed, shared, truncated and edited by hand. None of these is
    // worth an error page.
    for (const bad of ['', 'nonsense', '../../etc', '<script>', 'PRICE-ASC']) {
      expect(parseListingQuery({ sort: bad, status: bad })).toEqual(DEFAULT_QUERY);
    }
  });

  it('takes the last value when a parameter is repeated', () => {
    expect(parseListingQuery({ sort: ['price-asc', 'price-desc'] }).sort).toBe('price-desc');
    expect(parseListingQuery({ q: ['a', 'lodge'] }).q).toBe('lodge');
  });

  it('trims the search and bounds its length', () => {
    expect(parseListingQuery({ q: '  lodge  ' }).q).toBe('lodge');
    expect(parseListingQuery({ q: 'x'.repeat(500) }).q).toHaveLength(80);
  });

  it('knows when the view is no longer the default', () => {
    expect(isFiltered(DEFAULT_QUERY)).toBe(false);
    expect(isFiltered({ ...DEFAULT_QUERY, q: 'lodge' })).toBe(true);
    expect(isFiltered({ ...DEFAULT_QUERY, status: 'open' })).toBe(true);
    expect(isFiltered({ ...DEFAULT_QUERY, sort: 'price-asc' })).toBe(true);
  });

  it('groups only while nothing has been asked of it', () => {
    expect(isGrouped(DEFAULT_QUERY)).toBe(true);
    // Sorting and grouping are the same job done twice.
    expect(isGrouped({ ...DEFAULT_QUERY, sort: 'price-asc' })).toBe(false);
    expect(isGrouped({ ...DEFAULT_QUERY, status: 'open' })).toBe(false);
    // A search alone still groups: it narrows the set, it does not reorder it.
    expect(isGrouped({ ...DEFAULT_QUERY, q: 'lodge' })).toBe(true);
  });
});

describe('filtering and sorting', () => {
  const live = draw({ title: 'Highland lodge escape', ticketPriceMinor: 299, status: 'live' });
  const cheap = draw({ title: 'Last tickets', ticketPriceMinor: 100, status: 'live' });
  const soon = draw({
    title: 'Vintage whisky collection',
    ticketPriceMinor: 250,
    status: 'scheduled',
  });
  const all = [live, cheap, soon];

  it('returns everything by default, in the order the API gave', () => {
    expect(applyListing(all, DEFAULT_QUERY)).toEqual(all);
  });

  it('filters by status', () => {
    expect(applyListing(all, { ...DEFAULT_QUERY, status: 'open' })).toEqual([live, cheap]);
    expect(applyListing(all, { ...DEFAULT_QUERY, status: 'upcoming' })).toEqual([soon]);
  });

  it('searches the title, case-insensitively and on a partial word', () => {
    expect(applyListing(all, { ...DEFAULT_QUERY, q: 'lodge' })).toEqual([live]);
    expect(applyListing(all, { ...DEFAULT_QUERY, q: 'LODGE' })).toEqual([live]);
    expect(applyListing(all, { ...DEFAULT_QUERY, q: 'whisky' })).toEqual([soon]);
    expect(applyListing(all, { ...DEFAULT_QUERY, q: 'nothing here' })).toEqual([]);
  });

  it('sorts by price in both directions', () => {
    expect(applyListing(all, { ...DEFAULT_QUERY, sort: 'price-asc' })).toEqual([cheap, soon, live]);
    expect(applyListing(all, { ...DEFAULT_QUERY, sort: 'price-desc' })).toEqual([
      live,
      soon,
      cheap,
    ]);
  });

  it('sorts by closing and opening time', () => {
    const first = draw({ closesAt: new Date(Date.now() + HOUR).toISOString() });
    const later = draw({ closesAt: new Date(Date.now() + 90 * HOUR).toISOString() });
    expect(applyListing([later, first], { ...DEFAULT_QUERY, sort: 'closing-soon' })).toEqual([
      first,
      later,
    ]);
    const opensFirst = draw({ opensAt: new Date(Date.now() + HOUR).toISOString() });
    const opensLater = draw({ opensAt: new Date(Date.now() + 90 * HOUR).toISOString() });
    expect(
      applyListing([opensLater, opensFirst], { ...DEFAULT_QUERY, sort: 'opening-soon' }),
    ).toEqual([opensFirst, opensLater]);
  });

  it('sorts by winner positions, most first', () => {
    const one = draw({ winnerPositions: 1 });
    const five = draw({ winnerPositions: 5 });
    expect(applyListing([one, five], { ...DEFAULT_QUERY, sort: 'winners' })).toEqual([five, one]);
  });

  it('keeps ties in the order the API gave them', () => {
    // Two draws at the same price must not swap places between renders.
    const a = draw({ ticketPriceMinor: 500, title: 'A' });
    const b = draw({ ticketPriceMinor: 500, title: 'B' });
    expect(applyListing([a, b], { ...DEFAULT_QUERY, sort: 'price-asc' })).toEqual([a, b]);
  });

  it('does not mutate the list it was given', () => {
    const input = [live, cheap, soon];
    applyListing(input, { ...DEFAULT_QUERY, sort: 'price-asc' });
    expect(input).toEqual([live, cheap, soon]);
  });

  it('combines a filter and a search', () => {
    expect(applyListing(all, { ...DEFAULT_QUERY, status: 'upcoming', q: 'whisky' })).toEqual([
      soon,
    ]);
    expect(applyListing(all, { ...DEFAULT_QUERY, status: 'open', q: 'whisky' })).toEqual([]);
  });
});

describe('closing soon is presentation, not status', () => {
  it('is true only inside the window, and only for a live draw', () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(isClosingSoon(draw({ closesAt: at(HOUR) }), now)).toBe(true);
    expect(isClosingSoon(draw({ closesAt: at(CLOSING_SOON_MS - 1) }), now)).toBe(true);
    expect(isClosingSoon(draw({ closesAt: at(CLOSING_SOON_MS + HOUR) }), now)).toBe(false);
  });

  it('never contradicts the API', () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    // A scheduled draw is not closing, however near its closing time is.
    expect(isClosingSoon(draw({ status: 'scheduled', closesAt: at(HOUR) }), now)).toBe(false);
    // Already past: that is closed, and the API is the one that says so.
    expect(isClosingSoon(draw({ closesAt: at(-HOUR) }), now)).toBe(false);
  });
});

describe('the header summary', () => {
  it('counts what is actually being shown', () => {
    const shown = [
      draw({ status: 'live' }),
      draw({ status: 'live' }),
      draw({ status: 'scheduled' }),
    ];
    expect(summarise(shown)).toEqual({ total: 3, open: 2, upcoming: 1 });
    expect(summarise([])).toEqual({ total: 0, open: 0, upcoming: 0 });
  });
});
