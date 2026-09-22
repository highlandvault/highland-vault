import { z } from 'zod';

export const MarketCodeSchema = z.enum(['uk', 'ie', 'de']);

/** Route parameter for market-scoped paths: any two lower-case letters reach the market guard. */
export const MarketParamSchema = z.object({
  market: z.string().regex(/^[a-z]{2}$/, 'must be a two-letter lower-case market code'),
});

/** A market available to customers (public view). */
export const MarketSchema = z.object({
  code: MarketCodeSchema,
  name: z.string(),
  currency: z.enum(['GBP', 'EUR']),
  locale: z.string(),
});
export type Market = z.infer<typeof MarketSchema>;

/** GET /markets — markets currently available (environment allow-list AND enabled). */
export const MarketListResponseSchema = z.object({
  markets: z.array(MarketSchema),
});
export type MarketListResponse = z.infer<typeof MarketListResponseSchema>;

/** GET /markets/:market */
export const MarketResponseSchema = z.object({
  market: MarketSchema,
});
export type MarketResponse = z.infer<typeof MarketResponseSchema>;
