import 'server-only';
import { type Market, MarketListResponseSchema, MarketResponseSchema } from '@hv/contracts';
import { cache } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Market availability comes from the API (ADR-0005): the web app keeps no
 * allow-list of its own, so hiding or showing a market here can never open a
 * market the API refuses. Only the URL shape is checked locally.
 */
export const MARKET_SEGMENT = /^[a-z]{2}$/;

/**
 * The market for a route segment, or null when the API does not serve it (→ 404).
 * Cached per request, so the market layout and its pages ask the API once.
 */
export const fetchMarket = cache(async (segment: string): Promise<Market | null> => {
  if (!MARKET_SEGMENT.test(segment)) return null;
  const result = await apiFetch(`/markets/${segment}`, {
    parse: (json) => MarketResponseSchema.parse(json).market,
  });
  if (result.ok) return result.data;
  if (result.status === 404) return null;
  throw new Error(`Market lookup failed: ${result.code}`);
});

export async function fetchMarkets(): Promise<Market[] | null> {
  const result = await apiFetch('/markets', {
    parse: (json) => MarketListResponseSchema.parse(json).markets,
  });
  return result.ok ? result.data : null;
}
