/**
 * Market time zones and wall-clock conversion. Timestamps are stored in UTC;
 * staff enter, and customers read, times in the market's own time zone.
 * Pure Intl arithmetic, no date library.
 */
import type { MarketCode } from './markets';

export const MARKET_TIME_ZONES: Readonly<Record<MarketCode, string>> = Object.freeze({
  uk: 'Europe/London',
  ie: 'Europe/Dublin',
  de: 'Europe/Berlin',
});

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export class TimeError extends Error {
  override readonly name = 'TimeError';
}

/**
 * Converts a wall-clock time ("2026-10-01T18:00", as from <input type=datetime-local>)
 * in `timeZone` to the UTC instant. Times that do not exist (the spring-forward
 * gap) are rejected rather than shifted silently.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) throw new TimeError(`Not a local date-time: ${local}`);
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset around DST changes.
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  const result = new Date(guess);
  if (utcToZonedLocal(result, timeZone) !== local) {
    throw new TimeError(`${local} does not exist in ${timeZone} (daylight-saving change)`);
  }
  return result;
}

/** The wall-clock time of `instant` in `timeZone`, formatted like <input type=datetime-local>. */
export function utcToZonedLocal(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + offsetMs(instant, timeZone));
  return shifted.toISOString().slice(0, 16);
}
