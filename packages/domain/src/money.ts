/**
 * Money as integer minor units (SPEC §13). Floating-point amounts are rejected
 * everywhere; there is intentionally no conversion from a decimal number.
 */

export const CURRENCIES = ['GBP', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Both supported currencies use 2 minor-unit digits (pence / cent). */
const MINOR_UNIT_DIGITS: Record<Currency, number> = { GBP: 2, EUR: 2 };

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

function assertSafeInteger(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Amount must be a safe integer of minor units, got ${amountMinor}`);
  }
}

export function money(amountMinor: number, currency: Currency): Money {
  assertSafeInteger(amountMinor);
  if (!isCurrency(currency)) {
    throw new MoneyError(`Unsupported currency: ${String(currency)}`);
  }
  return Object.freeze({ amountMinor, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Exact decimal string, e.g. 1234 GBP -> "12.34", -5 EUR -> "-0.05". No float arithmetic. */
export function toDecimalString(value: Money): string {
  const digits = MINOR_UNIT_DIGITS[value.currency];
  const negative = value.amountMinor < 0;
  const abs = String(Math.abs(value.amountMinor)).padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const fraction = abs.slice(abs.length - digits);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Locale-aware display formatting (en-GB, en-IE, de-DE). The exact decimal
 * string is passed to Intl, which formats string input without converting it
 * to a binary float.
 */
export function formatMoney(value: Money, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: MINOR_UNIT_DIGITS[value.currency],
    maximumFractionDigits: MINOR_UNIT_DIGITS[value.currency],
  });
  return formatter.format(toDecimalString(value) as Intl.StringNumericLiteral);
}

/**
 * Parses a typed decimal amount ("2.50", "12", "0.99") into Money without any
 * float arithmetic: the digits are read as a string. More fraction digits than
 * the currency has, signs, exponents and separators are rejected.
 */
export function parseDecimalMoney(input: string, currency: Currency): Money {
  const digits = MINOR_UNIT_DIGITS[currency];
  const match = /^(\d{1,13})(?:\.(\d+))?$/.exec(input.trim());
  if (!match || (match[2] !== undefined && match[2].length > digits)) {
    throw new MoneyError(`Not an amount with at most ${digits} decimal places: ${input}`);
  }
  const fraction = (match[2] ?? '').padEnd(digits, '0');
  return money(Number(`${match[1]}${fraction}`), currency);
}
