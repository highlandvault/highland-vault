/**
 * Phase 1 static routing allow-list (ADR-0005). Germany ('de') is deliberately
 * absent: it stays gated until legal approval, so /de returns 404. From Phase 2
 * the API is the authority for market availability; this list only shapes routes.
 */
export const WEB_MARKETS = {
  uk: { name: 'United Kingdom', locale: 'en-GB', currency: 'GBP' },
  ie: { name: 'Ireland', locale: 'en-IE', currency: 'EUR' },
} as const;

export type WebMarketCode = keyof typeof WEB_MARKETS;

export function isWebMarket(value: string): value is WebMarketCode {
  return Object.hasOwn(WEB_MARKETS, value);
}
