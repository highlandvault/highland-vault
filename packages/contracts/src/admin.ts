import { z } from 'zod';
import { MarketCodeSchema } from './markets';

/** Sensitive operations always carry a non-empty reason, stored in the audit log (ADR-0010). */
export const ReasonSchema = z.string().trim().min(3).max(500);

/** The full gate state of a market, for staff. */
export const AdminMarketSchema = z.object({
  code: MarketCodeSchema,
  name: z.string(),
  currency: z.enum(['GBP', 'EUR']),
  locale: z.string(),
  isEnabled: z.boolean(),
  /** Layer 2: whether ENABLED_MARKETS on this API instance allows the market. */
  environmentAllowed: z.boolean(),
  /** Enabled AND allowed by the environment. */
  available: z.boolean(),
  requiresLegalApproval: z.boolean(),
  legalApproval: z
    .object({
      approvedAt: z.iso.datetime(),
      approvedBy: z.uuid(),
      reference: z.string(),
    })
    .nullable(),
  settings: z.object({
    minAge: z.number().int().nullable(),
    selfExclusionRequired: z.boolean().nullable(),
  }),
  /** Required compliance settings that are still unset (OPEN O12). */
  missingSettings: z.array(z.string()),
});
export type AdminMarket = z.infer<typeof AdminMarketSchema>;

/** GET /admin/markets */
export const AdminMarketListResponseSchema = z.object({ markets: z.array(AdminMarketSchema) });
export type AdminMarketListResponse = z.infer<typeof AdminMarketListResponseSchema>;

/** Response of every market gate operation. */
export const AdminMarketResponseSchema = z.object({ market: AdminMarketSchema });
export type AdminMarketResponse = z.infer<typeof AdminMarketResponseSchema>;

/** PUT /admin/markets/:market/settings — values are entered by staff, never defaulted. */
export const UpdateMarketSettingsRequestSchema = z.strictObject({
  minAge: z.number().int().min(1).max(99).nullable(),
  selfExclusionRequired: z.boolean().nullable(),
  reason: ReasonSchema,
});
export type UpdateMarketSettingsRequest = z.infer<typeof UpdateMarketSettingsRequestSchema>;

/** POST /admin/markets/:market/legal-approval */
export const RecordLegalApprovalRequestSchema = z.strictObject({
  reference: z.string().trim().min(1).max(200),
  reason: ReasonSchema,
});
export type RecordLegalApprovalRequest = z.infer<typeof RecordLegalApprovalRequestSchema>;

/** POST /admin/markets/:market/enable and /disable */
export const MarketGateChangeRequestSchema = z.strictObject({ reason: ReasonSchema });
export type MarketGateChangeRequest = z.infer<typeof MarketGateChangeRequestSchema>;
