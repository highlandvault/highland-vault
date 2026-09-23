import { z } from 'zod';
import { ReasonSchema } from './admin';

export const DrawStatusSchema = z.enum([
  'draft',
  'scheduled',
  'live',
  'closed',
  'settled',
  'completed',
  'cancelled',
]);
export type DrawStatusDto = z.infer<typeof DrawStatusSchema>;

/** Route parameter for customer draw pages. */
export const DrawSlugParamSchema = z.object({
  market: z.string(),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(80),
});

export const PublicPrizeSchema = z.object({
  position: z.number().int(),
  title: z.string(),
  description: z.string(),
});
export type PublicPrize = z.infer<typeof PublicPrizeSchema>;

/**
 * The skill question as customers see it. Deliberately has NO field for the
 * correct answer: that never leaves the API (answers are checked in Phase 5).
 */
export const PublicSkillQuestionSchema = z.strictObject({
  prompt: z.string(),
  options: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
});
export type PublicSkillQuestion = z.infer<typeof PublicSkillQuestionSchema>;

const PublicDrawBase = z.object({
  slug: z.string(),
  title: z.string(),
  /** Effective status (time-based transitions applied). Never draft or cancelled. */
  status: z.enum(['scheduled', 'live', 'closed', 'settled', 'completed']),
  currency: z.enum(['GBP', 'EUR']),
  /** Integer minor units (pence / cent). */
  ticketPriceMinor: z.number().int().positive(),
  totalTickets: z.number().int().positive(),
  maxPerPerson: z.number().int().positive(),
  winnerPositions: z.number().int().positive(),
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
});

export const PublicDrawSummarySchema = PublicDrawBase.extend({
  /** Title of the first-position prize. */
  headlinePrize: z.string().nullable(),
});
export type PublicDrawSummary = z.infer<typeof PublicDrawSummarySchema>;

export const PublicDrawDetailSchema = PublicDrawBase.extend({
  description: z.string(),
  prizes: z.array(PublicPrizeSchema),
  skillQuestion: PublicSkillQuestionSchema,
});
export type PublicDrawDetail = z.infer<typeof PublicDrawDetailSchema>;

/** GET /markets/:market/draws */
export const DrawListResponseSchema = z.object({ draws: z.array(PublicDrawSummarySchema) });
export type DrawListResponse = z.infer<typeof DrawListResponseSchema>;

/** GET /markets/:market/draws/:slug */
export const DrawResponseSchema = z.object({ draw: PublicDrawDetailSchema });
export type DrawResponse = z.infer<typeof DrawResponseSchema>;

// ---------------------------------------------------------------------------
// Admin

export const AdminDrawSchema = z.object({
  id: z.uuid(),
  market: z.enum(['uk', 'ie', 'de']),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  status: DrawStatusSchema,
  effectiveStatus: DrawStatusSchema,
  currency: z.enum(['GBP', 'EUR']),
  ticketPriceMinor: z.number().int(),
  totalTickets: z.number().int(),
  maxPerPerson: z.number().int(),
  winnerPositions: z.number().int(),
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  prizes: z.array(PublicPrizeSchema),
  skillQuestion: z
    .object({
      prompt: z.string(),
      options: z.array(z.object({ id: z.uuid(), label: z.string(), isCorrect: z.boolean() })),
    })
    .nullable(),
  /** Why the draw cannot be published yet (empty when it can, or when it is not a draft). */
  publishBlockers: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminDraw = z.infer<typeof AdminDrawSchema>;

export const AdminDrawListResponseSchema = z.object({ draws: z.array(AdminDrawSchema) });
export type AdminDrawListResponse = z.infer<typeof AdminDrawListResponseSchema>;

export const AdminDrawResponseSchema = z.object({ draw: AdminDrawSchema });
export type AdminDrawResponse = z.infer<typeof AdminDrawResponseSchema>;

export const DrawIdParamSchema = z.object({ market: z.string(), draw: z.uuid() });

/** POST /admin/markets/:market/draws and PUT /admin/markets/:market/draws/:draw (drafts only). */
export const DrawConfigRequestSchema = z.strictObject({
  slug: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  ticketPriceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalTickets: z.number().int().positive().max(1_000_000),
  maxPerPerson: z.number().int().positive(),
  winnerPositions: z.number().int().positive().max(32_767),
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
});
export type DrawConfigRequest = z.infer<typeof DrawConfigRequestSchema>;

/** PUT /admin/markets/:market/draws/:draw/prizes — the complete prize list, one per position. */
export const ReplacePrizesRequestSchema = z.strictObject({
  prizes: z
    .array(
      z.strictObject({
        position: z.number().int().min(1).max(32_767),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(2000).default(''),
      }),
    )
    .max(100),
});
export type ReplacePrizesRequest = z.infer<typeof ReplacePrizesRequestSchema>;

/** PUT /admin/markets/:market/draws/:draw/skill-question */
export const SkillQuestionRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(500),
  options: z
    .array(z.strictObject({ label: z.string().trim().min(1).max(200), isCorrect: z.boolean() }))
    .min(2)
    .max(10)
    .refine((options) => options.filter((o) => o.isCorrect).length === 1, {
      message: 'exactly one option must be correct',
    }),
});
export type SkillQuestionRequest = z.infer<typeof SkillQuestionRequestSchema>;

/** POST /admin/markets/:market/draws/:draw/publish */
export const PublishDrawRequestSchema = z.strictObject({ reason: ReasonSchema.optional() });
export type PublishDrawRequest = z.infer<typeof PublishDrawRequestSchema>;

/** POST /admin/markets/:market/draws/:draw/cancel */
export const CancelDrawRequestSchema = z.strictObject({ reason: ReasonSchema });
export type CancelDrawRequest = z.infer<typeof CancelDrawRequestSchema>;
