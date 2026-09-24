/**
 * The verified-email window (ADR-0020, ADR-0029).
 *
 * Proving you can read an inbox is good for half an hour, not for the day the
 * guest session lasts, and the window is judged on every use rather than
 * cached — so these are the boundaries checkout will rely on.
 */
import { describe, expect, it } from 'vitest';
import type { GuestContext } from './guest-sessions.repository';
import { GuestSessionsService } from './guest-sessions.service';

const TTL_MINUTES = 30;
const service = new GuestSessionsService(
  null as never,
  { GUEST_VERIFIED_EMAIL_TTL_MINUTES: TTL_MINUTES } as never,
  null as never,
);

const NOW = new Date('2026-09-24T12:00:00Z');
const guest = (verifiedEmail: string | null, verifiedMinutesAgo?: number): GuestContext => ({
  guestSessionId: 'g1',
  verifiedEmail,
  verifiedEmailAt:
    verifiedMinutesAgo === undefined ? null : new Date(NOW.getTime() - verifiedMinutesAgo * 60_000),
  expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
});

describe('a verified email is only good for a short while', () => {
  it('accepts one verified just now', () => {
    expect(service.hasFreshVerifiedEmail(guest('a@example.com', 0), NOW)).toBe(true);
  });

  it('accepts one inside the window', () => {
    expect(service.hasFreshVerifiedEmail(guest('a@example.com', TTL_MINUTES - 1), NOW)).toBe(true);
  });

  it('refuses one exactly at the window', () => {
    // The boundary is exclusive, so "30 minutes" is not still valid.
    expect(service.hasFreshVerifiedEmail(guest('a@example.com', TTL_MINUTES), NOW)).toBe(false);
  });

  it('refuses one past the window', () => {
    expect(service.hasFreshVerifiedEmail(guest('a@example.com', TTL_MINUTES + 1), NOW)).toBe(false);
  });

  it('refuses a session that has verified nothing', () => {
    expect(service.hasFreshVerifiedEmail(guest(null), NOW)).toBe(false);
  });

  it('refuses a verification timestamp in the future', () => {
    // A clock that has gone backwards must not extend the window.
    expect(service.hasFreshVerifiedEmail(guest('a@example.com', -5), NOW)).toBe(false);
  });

  it('refuses an address recorded without a time, whatever the database allows', () => {
    const malformed = { ...guest('a@example.com'), verifiedEmailAt: null };
    expect(service.hasFreshVerifiedEmail(malformed, NOW)).toBe(false);
  });

  it('does not treat a live session as a fresh verification', () => {
    // The session lasts a day; the verification does not inherit that.
    const stale = guest('a@example.com', 23 * 60);
    expect(stale.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(service.hasFreshVerifiedEmail(stale, NOW)).toBe(false);
  });
});
