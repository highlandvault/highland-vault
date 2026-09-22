/**
 * Draw rules (Revision 2 B14 lifecycle, D-1 constraints, ADR-0004).
 *
 * The database is the final authority (migration 0008: hv_draws_guard and the
 * draws_* constraints). These pure functions give services the same answers
 * up front so the API can explain a refusal.
 */

export const DRAW_STATUSES = [
  'draft',
  'scheduled',
  'live',
  'closed',
  'settled',
  'completed',
  'cancelled',
] as const;
export type DrawStatus = (typeof DRAW_STATUSES)[number];

export function isDrawStatus(value: unknown): value is DrawStatus {
  return typeof value === 'string' && (DRAW_STATUSES as readonly string[]).includes(value);
}

/**
 * Every allowed status change. Cancelling a live draw is OPEN (O6) and is
 * deliberately absent. Nothing ever returns to an earlier state.
 */
const TRANSITIONS: Readonly<Record<DrawStatus, readonly DrawStatus[]>> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['live', 'cancelled'],
  live: ['closed'],
  closed: ['settled'],
  settled: ['completed'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: DrawStatus, to: DrawStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class DrawRuleError extends Error {
  override readonly name = 'DrawRuleError';
}

export function assertTransition(from: DrawStatus, to: DrawStatus): void {
  if (!canTransition(from, to)) {
    throw new DrawRuleError(`A draw cannot change from ${from} to ${to}`);
  }
}

/** Only a draft may be edited; afterwards the configuration is frozen (changes are OPEN O9). */
export function isEditable(status: DrawStatus): boolean {
  return status === 'draft';
}

/** Published = customers may see it. Drafts and cancelled draws are never shown. */
export function isPublished(status: DrawStatus): boolean {
  return status !== 'draft' && status !== 'cancelled';
}

/** What customers browse: upcoming and open draws. Closed ones stay reachable by URL. */
export const LISTED_STATUSES: readonly DrawStatus[] = ['scheduled', 'live'];

export interface DrawTiming {
  readonly status: DrawStatus;
  readonly opensAt: Date;
  readonly closesAt: Date;
}

/**
 * The status as of `now`. The lifecycle sweeper applies time-based changes
 * about once a minute; in between, a scheduled draw past its opening time is
 * already open, and a live draw past its closing time is already closed.
 * Nothing may be sold on the stored status alone.
 */
export function effectiveStatus(draw: DrawTiming, now: Date): DrawStatus {
  if (draw.status === 'scheduled' && draw.opensAt <= now) {
    return draw.closesAt <= now ? 'closed' : 'live';
  }
  if (draw.status === 'live' && draw.closesAt <= now) return 'closed';
  return draw.status;
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 80;

export interface DrawConfig {
  readonly slug: string;
  readonly title: string;
  readonly ticketPriceMinor: number;
  readonly totalTickets: number;
  readonly maxPerPerson: number;
  readonly winnerPositions: number;
  readonly opensAt: Date;
  readonly closesAt: Date;
}

export interface RuleViolation {
  readonly field: string;
  readonly message: string;
}

/** Every problem with a draw's configuration (empty = valid). Mirrors the draws_* CHECKs. */
export function validateDrawConfig(config: DrawConfig): RuleViolation[] {
  const problems: RuleViolation[] = [];
  const positiveInt = (value: number) => Number.isSafeInteger(value) && value > 0;

  if (!SLUG_PATTERN.test(config.slug) || config.slug.length > SLUG_MAX_LENGTH) {
    problems.push({
      field: 'slug',
      message: `lower-case letters, digits and single hyphens, at most ${SLUG_MAX_LENGTH} characters`,
    });
  }
  if (config.title.trim().length === 0 || config.title.length > 200) {
    problems.push({ field: 'title', message: 'required, at most 200 characters' });
  }
  if (!positiveInt(config.ticketPriceMinor)) {
    problems.push({
      field: 'ticketPriceMinor',
      message: 'must be a positive whole number of minor units',
    });
  }
  if (!positiveInt(config.totalTickets) || config.totalTickets > 2_147_483_647) {
    problems.push({ field: 'totalTickets', message: 'must be a positive whole number' });
  }
  if (!positiveInt(config.maxPerPerson) || config.maxPerPerson > config.totalTickets) {
    problems.push({
      field: 'maxPerPerson',
      message: 'must be a positive whole number, at most the total number of tickets',
    });
  }
  if (
    !positiveInt(config.winnerPositions) ||
    config.winnerPositions > config.totalTickets ||
    config.winnerPositions > 32_767
  ) {
    problems.push({
      field: 'winnerPositions',
      message: 'must be a positive whole number, at most the total number of tickets',
    });
  }
  if (!(config.opensAt < config.closesAt)) {
    problems.push({ field: 'closesAt', message: 'must be after the opening time' });
  }
  return problems;
}

export type PublishBlocker =
  | 'skill_question_missing'
  | 'skill_question_incomplete'
  | 'prizes_incomplete'
  | 'closes_at_in_past';

export interface PublishCheckInput {
  readonly winnerPositions: number;
  readonly closesAt: Date;
  /** Positions that have a prize. */
  readonly prizePositions: readonly number[];
  /** null when no skill question is attached. */
  readonly skillQuestion: { readonly options: readonly { readonly isCorrect: boolean }[] } | null;
}

/**
 * Why a draft cannot be published yet (empty = publishable). Same rules as
 * hv_draw_publish_blockers() in the database.
 */
export function publishBlockers(input: PublishCheckInput, now: Date): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (!input.skillQuestion) {
    blockers.push('skill_question_missing');
  } else if (
    input.skillQuestion.options.length < 2 ||
    input.skillQuestion.options.filter((o) => o.isCorrect).length !== 1
  ) {
    blockers.push('skill_question_incomplete');
  }
  const positions = new Set(input.prizePositions);
  const complete =
    positions.size === input.prizePositions.length &&
    positions.size === input.winnerPositions &&
    [...positions].every((p) => Number.isInteger(p) && p >= 1 && p <= input.winnerPositions);
  if (!complete) blockers.push('prizes_incomplete');
  if (input.closesAt <= now) blockers.push('closes_at_in_past');
  return blockers;
}

/** Cancellation is possible before a draw goes live. Cancelling a live draw is OPEN (O6). */
export function canCancel(status: DrawStatus): boolean {
  return canTransition(status, 'cancelled');
}
