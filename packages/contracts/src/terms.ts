import { z } from 'zod';

/**
 * Market terms and accepting them (Revision 2 B12 and B18, ADR-0031).
 *
 * There is no wording in any of these shapes. B12 marks the content "legal"
 * and Part F puts per-market terms in Phase 12; what Phase 5 needs is which
 * version a market is on, and a record of who agreed to it. A `content` field
 * here would be an invitation to fill it with something invented.
 */

export const TermsVersionSchema = z.object({
  id: z.uuid(),
  market: z.enum(['uk', 'ie', 'de']),
  /** The publisher's label for this revision, unique within the market. */
  version: z.string().min(1).max(64),
  /** Null while the version is still a draft. */
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type TermsVersion = z.infer<typeof TermsVersionSchema>;

/**
 * GET /markets/:market/terms — the version a checkout in this market would be
 * placed under.
 *
 * `active` is null when the market has no terms yet. That is a real state, not
 * an error: the market can still be browsed, it simply cannot take an order
 * (ADR-0031), which is what `checkoutAllowed` says in one field.
 */
export const MarketTermsResponseSchema = z.object({
  active: TermsVersionSchema.nullable(),
  /** False when there is no active version, so checkout cannot create an order. */
  checkoutAllowed: z.boolean(),
  /** Whether the caller has already accepted the active version; null when nobody is identified. */
  accepted: z.boolean().nullable(),
  serverTime: z.iso.datetime(),
});
export type MarketTermsResponse = z.infer<typeof MarketTermsResponseSchema>;

/** POST /markets/:market/terms/acceptance — accepts whichever version is active. */
export const AcceptTermsRequestSchema = z.strictObject({
  /**
   * The version the customer was shown. Checked against the active one, so a
   * stale page cannot record agreement to terms that have since changed.
   */
  version: z.string().min(1).max(64),
});
export type AcceptTermsRequest = z.infer<typeof AcceptTermsRequestSchema>;

export const TermsAcceptanceSchema = z.object({
  termsVersion: TermsVersionSchema,
  acceptedAt: z.iso.datetime(),
  /** Which kind of checkout identity accepted; never an identifier. */
  acceptedBy: z.enum(['user', 'guest']),
});
export type TermsAcceptance = z.infer<typeof TermsAcceptanceSchema>;

export const TermsAcceptanceResponseSchema = z.object({ acceptance: TermsAcceptanceSchema });
export type TermsAcceptanceResponse = z.infer<typeof TermsAcceptanceResponseSchema>;

// --- admin ------------------------------------------------------------------

export const CreateTermsVersionRequestSchema = z.strictObject({
  version: z.string().min(1).max(64),
  /** Publish immediately, rather than leaving a draft to publish later. */
  publish: z.boolean().optional(),
  reason: z.string().min(3).max(500),
});
export type CreateTermsVersionRequest = z.infer<typeof CreateTermsVersionRequestSchema>;

export const TermsVersionActionRequestSchema = z.strictObject({
  reason: z.string().min(3).max(500),
});
export type TermsVersionActionRequest = z.infer<typeof TermsVersionActionRequestSchema>;

export const TermsVersionIdParamSchema = z.object({ market: z.string(), terms: z.uuid() });

export const AdminTermsVersionSchema = TermsVersionSchema.extend({
  /** Whether this is the version the market is currently on. */
  active: z.boolean(),
});
export type AdminTermsVersion = z.infer<typeof AdminTermsVersionSchema>;

export const AdminTermsListResponseSchema = z.object({
  versions: z.array(AdminTermsVersionSchema),
});
export type AdminTermsListResponse = z.infer<typeof AdminTermsListResponseSchema>;

export const AdminTermsVersionResponseSchema = z.object({ version: AdminTermsVersionSchema });
export type AdminTermsVersionResponse = z.infer<typeof AdminTermsVersionResponseSchema>;
