/**
 * Display formatting for a market: money from integer minor units (never
 * floats) and dates in the market's own time zone. Safe for server and client.
 */
import { MARKET_TIME_ZONES, formatMoney, isMarketCode, money, type Currency } from '@hv/domain';

export function formatPrice(amountMinor: number, currency: Currency, locale: string): string {
  return formatMoney(money(amountMinor, currency), locale);
}

export function marketTimeZone(marketCode: string): string {
  return isMarketCode(marketCode) ? MARKET_TIME_ZONES[marketCode] : 'UTC';
}

/** "Thu 15 Oct 2026, 20:00 BST" in the market's zone and locale. */
export function formatDateTime(iso: string, locale: string, marketCode: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: marketTimeZone(marketCode),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** "in 3 days", "in 5 hours" — coarse and honest; the exact time is always shown beside it. */
export function formatRelative(iso: string, locale: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function ordinal(position: number): string {
  const rem100 = position % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[position % 10] ?? 'th');
  return `${position}${suffix}`;
}
