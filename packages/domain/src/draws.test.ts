import { describe, expect, it } from 'vitest';
import {
  DRAW_STATUSES,
  DrawRuleError,
  assertTransition,
  canCancel,
  canTransition,
  effectiveStatus,
  isEditable,
  isPublished,
  publishBlockers,
  validateDrawConfig,
  type DrawConfig,
  type DrawStatus,
} from './draws';

const valid: DrawConfig = {
  slug: 'porsche-911',
  title: 'Porsche 911',
  ticketPriceMinor: 250,
  totalTickets: 10_000,
  maxPerPerson: 50,
  winnerPositions: 3,
  opensAt: new Date('2026-10-01T09:00:00Z'),
  closesAt: new Date('2026-10-15T20:00:00Z'),
};

describe('draw lifecycle', () => {
  const allowed: [DrawStatus, DrawStatus][] = [
    ['draft', 'scheduled'],
    ['scheduled', 'live'],
    ['live', 'closed'],
    ['closed', 'settled'],
    ['settled', 'completed'],
    ['draft', 'cancelled'],
    ['scheduled', 'cancelled'],
  ];

  it('allows exactly the lifecycle transitions of Revision 2 B14', () => {
    for (const from of DRAW_STATUSES) {
      for (const to of DRAW_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it.each([
    ['closed', 'live'],
    ['live', 'scheduled'],
    ['live', 'draft'],
    ['cancelled', 'draft'],
    ['completed', 'live'],
    ['draft', 'live'],
    ['scheduled', 'closed'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(DrawRuleError);
  });

  it('does not allow cancelling a live draw (OPEN O6)', () => {
    expect(canCancel('draft')).toBe(true);
    expect(canCancel('scheduled')).toBe(true);
    expect(canCancel('live')).toBe(false);
    expect(canCancel('closed')).toBe(false);
  });

  it('only drafts are editable; drafts and cancelled draws are unpublished', () => {
    expect(DRAW_STATUSES.filter(isEditable)).toEqual(['draft']);
    expect(DRAW_STATUSES.filter((s) => !isPublished(s))).toEqual(['draft', 'cancelled']);
  });
});

describe('effective status', () => {
  const opensAt = new Date('2026-10-01T09:00:00Z');
  const closesAt = new Date('2026-10-15T20:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('opens a scheduled draw at its opening time, before the sweeper runs', () => {
    expect(
      effectiveStatus({ status: 'scheduled', opensAt, closesAt }, at('2026-10-01T08:59:59Z')),
    ).toBe('scheduled');
    expect(
      effectiveStatus({ status: 'scheduled', opensAt, closesAt }, at('2026-10-01T09:00:00Z')),
    ).toBe('live');
  });

  it('closes a live draw at its closing time, before the sweeper runs', () => {
    expect(effectiveStatus({ status: 'live', opensAt, closesAt }, at('2026-10-15T19:59:59Z'))).toBe(
      'live',
    );
    expect(effectiveStatus({ status: 'live', opensAt, closesAt }, at('2026-10-15T20:00:00Z'))).toBe(
      'closed',
    );
    expect(
      effectiveStatus({ status: 'scheduled', opensAt, closesAt }, at('2026-10-16T00:00:00Z')),
    ).toBe('closed');
  });

  it('never changes drafts, cancelled or finished draws', () => {
    for (const status of ['draft', 'cancelled', 'closed', 'settled'] as const) {
      expect(effectiveStatus({ status, opensAt, closesAt }, at('2030-01-01T00:00:00Z'))).toBe(
        status,
      );
    }
  });
});

describe('draw configuration', () => {
  it('accepts a valid configuration', () => {
    expect(validateDrawConfig(valid)).toEqual([]);
  });

  const fields = (config: Partial<DrawConfig>) =>
    validateDrawConfig({ ...valid, ...config }).map((p) => p.field);

  it('rejects a zero, negative or fractional ticket price (integer minor units only)', () => {
    expect(fields({ ticketPriceMinor: 0 })).toEqual(['ticketPriceMinor']);
    expect(fields({ ticketPriceMinor: -250 })).toEqual(['ticketPriceMinor']);
    expect(fields({ ticketPriceMinor: 2.5 })).toEqual(['ticketPriceMinor']);
  });

  it('rejects invalid capacity, caps and winner positions', () => {
    expect(fields({ totalTickets: 0 })).toContain('totalTickets');
    expect(fields({ maxPerPerson: 0 })).toEqual(['maxPerPerson']);
    expect(fields({ maxPerPerson: 10_001 })).toEqual(['maxPerPerson']);
    expect(fields({ winnerPositions: 0 })).toEqual(['winnerPositions']);
    expect(fields({ totalTickets: 2, maxPerPerson: 2, winnerPositions: 3 })).toEqual([
      'winnerPositions',
    ]);
  });

  it('requires the closing time after the opening time', () => {
    expect(fields({ closesAt: valid.opensAt })).toEqual(['closesAt']);
    expect(fields({ closesAt: new Date('2026-09-30T00:00:00Z') })).toEqual(['closesAt']);
  });

  it.each(['Porsche', 'porsche_911', '-porsche', 'porsche-', 'por--sche', 'a'.repeat(81), ''])(
    'rejects the slug %j',
    (slug) => {
      expect(fields({ slug })).toEqual(['slug']);
    },
  );
});

describe('publish blockers', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const question = { options: [{ isCorrect: false }, { isCorrect: true }, { isCorrect: false }] };

  it('allows a complete draft', () => {
    expect(
      publishBlockers(
        {
          winnerPositions: 3,
          closesAt: valid.closesAt,
          prizePositions: [1, 2, 3],
          skillQuestion: question,
        },
        now,
      ),
    ).toEqual([]);
  });

  it('requires a skill question with at least two options and exactly one correct', () => {
    const base = { winnerPositions: 1, closesAt: valid.closesAt, prizePositions: [1] };
    expect(publishBlockers({ ...base, skillQuestion: null }, now)).toEqual([
      'skill_question_missing',
    ]);
    for (const options of [
      [{ isCorrect: true }],
      [{ isCorrect: false }, { isCorrect: false }],
      [{ isCorrect: true }, { isCorrect: true }],
    ]) {
      expect(publishBlockers({ ...base, skillQuestion: { options } }, now)).toEqual([
        'skill_question_incomplete',
      ]);
    }
  });

  it('requires exactly one prize for every winner position', () => {
    const base = { winnerPositions: 3, closesAt: valid.closesAt, skillQuestion: question };
    for (const prizePositions of [[], [1, 2], [1, 2, 4], [1, 2, 3, 4], [1, 1, 2]]) {
      expect(
        publishBlockers({ ...base, prizePositions }, now),
        JSON.stringify(prizePositions),
      ).toEqual(['prizes_incomplete']);
    }
  });

  it('refuses to publish a draw whose closing time has passed', () => {
    expect(
      publishBlockers(
        { winnerPositions: 1, closesAt: now, prizePositions: [1], skillQuestion: question },
        now,
      ),
    ).toEqual(['closes_at_in_past']);
  });
});

describe('pool size limit', () => {
  it('caps a draw at 1,000,000 tickets (the pool is created in one statement)', () => {
    expect(validateDrawConfig({ ...valid, totalTickets: 1_000_000 }).map((p) => p.field)).toEqual(
      [],
    );
    expect(validateDrawConfig({ ...valid, totalTickets: 1_000_001 }).map((p) => p.field)).toEqual([
      'totalTickets',
    ]);
  });
});
