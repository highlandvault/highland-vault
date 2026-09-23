import { describe, expect, it } from 'vitest';
import { MARKET_TIME_ZONES, TimeError, utcToZonedLocal, zonedLocalToUtc } from './time';

describe('market time zones', () => {
  it('names the zone of every market', () => {
    expect(MARKET_TIME_ZONES).toEqual({
      uk: 'Europe/London',
      ie: 'Europe/Dublin',
      de: 'Europe/Berlin',
    });
  });

  it('converts summer wall-clock time to UTC (BST / IST / CEST)', () => {
    expect(zonedLocalToUtc('2026-07-01T18:00', 'Europe/London').toISOString()).toBe(
      '2026-07-01T17:00:00.000Z',
    );
    expect(zonedLocalToUtc('2026-07-01T18:00', 'Europe/Dublin').toISOString()).toBe(
      '2026-07-01T17:00:00.000Z',
    );
    expect(zonedLocalToUtc('2026-07-01T18:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-01T16:00:00.000Z',
    );
  });

  it('converts winter wall-clock time to UTC (GMT / CET)', () => {
    expect(zonedLocalToUtc('2026-12-01T18:00', 'Europe/London').toISOString()).toBe(
      '2026-12-01T18:00:00.000Z',
    );
    expect(zonedLocalToUtc('2026-12-01T18:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-12-01T17:00:00.000Z',
    );
  });

  it('handles the days of the clock change', () => {
    // UK clocks go back at 02:00 BST on 2026-10-25.
    expect(zonedLocalToUtc('2026-10-25T12:00', 'Europe/London').toISOString()).toBe(
      '2026-10-25T12:00:00.000Z',
    );
    // UK clocks go forward at 01:00 GMT on 2026-03-29: 01:30 does not exist.
    expect(() => zonedLocalToUtc('2026-03-29T01:30', 'Europe/London')).toThrow(TimeError);
  });

  it('round-trips through the zone', () => {
    const instant = new Date('2026-10-15T19:30:00Z');
    for (const zone of Object.values(MARKET_TIME_ZONES)) {
      expect(zonedLocalToUtc(utcToZonedLocal(instant, zone), zone).getTime()).toBe(
        instant.getTime(),
      );
    }
  });

  it('rejects malformed input', () => {
    for (const input of ['2026-10-15', '2026-10-15 18:00', '15/10/2026 18:00', '']) {
      expect(() => zonedLocalToUtc(input, 'Europe/London')).toThrow(TimeError);
    }
  });
});
