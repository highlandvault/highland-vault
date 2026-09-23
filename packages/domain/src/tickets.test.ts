import { describe, expect, it } from 'vitest';
import {
  RESERVATION_TTL_SECONDS,
  TICKET_STATUSES,
  canTicketTransition,
  effectiveReservationStatus,
  entrantKey,
  formatTicketNumber,
  isOpenForEntries,
  isValidQuantity,
  remainingAllowance,
  reservationTotal,
} from './tickets';

describe('ticket states', () => {
  it('allows only available → reserved → sold and reserved → available', () => {
    const allowed = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => canTicketTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed).toEqual(['available→reserved', 'reserved→available', 'reserved→sold']);
  });

  it('never releases a sold ticket', () => {
    expect(canTicketTransition('sold', 'available')).toBe(false);
    expect(canTicketTransition('sold', 'reserved')).toBe(false);
  });
});

describe('reservation rules', () => {
  it('reserves for 10 minutes (D11)', () => {
    expect(RESERVATION_TTL_SECONDS).toBe(600);
  });

  it('accepts whole quantities from 1 up to the cap only', () => {
    expect(isValidQuantity(1, 10)).toBe(true);
    expect(isValidQuantity(10, 10)).toBe(true);
    for (const q of [0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidQuantity(q, 10), String(q)).toBe(false);
    }
  });

  it('computes the remaining allowance under the cap', () => {
    expect(remainingAllowance(0, 25)).toBe(25);
    expect(remainingAllowance(20, 25)).toBe(5);
    expect(remainingAllowance(25, 25)).toBe(0);
    expect(remainingAllowance(30, 25)).toBe(0);
  });

  it('computes exact totals in integer minor units', () => {
    expect(reservationTotal(299, 3)).toBe(897);
    expect(reservationTotal(10, 7)).toBe(70); // 0.1 × 7 would drift as floats
    expect(() => reservationTotal(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it('opens entries only while the draw is effectively live', () => {
    const opensAt = new Date('2026-10-01T09:00:00Z');
    const closesAt = new Date('2026-10-02T09:00:00Z');
    const during = new Date('2026-10-01T12:00:00Z');
    expect(isOpenForEntries({ status: 'live', opensAt, closesAt }, during)).toBe(true);
    // Scheduled but past its opening time: open, even before the sweeper runs.
    expect(isOpenForEntries({ status: 'scheduled', opensAt, closesAt }, during)).toBe(true);
    expect(
      isOpenForEntries(
        { status: 'scheduled', opensAt, closesAt },
        new Date('2026-10-01T08:00:00Z'),
      ),
    ).toBe(false);
    expect(isOpenForEntries({ status: 'live', opensAt, closesAt }, closesAt)).toBe(false);
    for (const status of ['draft', 'closed', 'cancelled', 'settled'] as const) {
      expect(isOpenForEntries({ status, opensAt, closesAt }, during), status).toBe(false);
    }
  });

  it('treats an active reservation past its expiry as expired', () => {
    const expiresAt = new Date('2026-10-01T12:10:00Z');
    expect(effectiveReservationStatus('active', expiresAt, new Date('2026-10-01T12:09:59Z'))).toBe(
      'active',
    );
    expect(effectiveReservationStatus('active', expiresAt, expiresAt)).toBe('expired');
    expect(
      effectiveReservationStatus('released', expiresAt, new Date('2026-10-01T12:00:00Z')),
    ).toBe('released');
  });
});

describe('entrant identity', () => {
  it('keys users by id and guests by normalized verified email', () => {
    expect(entrantKey({ type: 'user', userId: 'u-1' })).toEqual({ type: 'user', ref: 'u-1' });
    expect(entrantKey({ type: 'email', verifiedEmail: '  Jane@Example.COM ' })).toEqual({
      type: 'email',
      ref: 'jane@example.com',
    });
  });
});

describe('ticket number display', () => {
  it('zero-pads to the width of the largest number in the draw', () => {
    expect(formatTicketNumber(21, 50_000)).toBe('00021');
    expect(formatTicketNumber(50_000, 50_000)).toBe('50000');
    expect(formatTicketNumber(7, 999)).toBe('007');
    expect(formatTicketNumber(3, 9)).toBe('3');
  });
});
