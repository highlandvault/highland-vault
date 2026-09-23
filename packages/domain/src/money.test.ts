import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addMoney,
  formatMoney,
  isCurrency,
  money,
  parseDecimalMoney,
  subtractMoney,
  toDecimalString,
} from './money';

describe('money', () => {
  it('accepts integer minor units', () => {
    expect(money(1234, 'GBP')).toEqual({ amountMinor: 1234, currency: 'GBP' });
  });

  it('rejects fractional amounts (no floats for money)', () => {
    expect(() => money(12.5, 'GBP')).toThrow(MoneyError);
    expect(() => money(0.1 + 0.2, 'EUR')).toThrow(MoneyError);
  });

  it('rejects unsafe integers and non-finite values', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'GBP')).toThrow(MoneyError);
    expect(() => money(Number.NaN, 'GBP')).toThrow(MoneyError);
    expect(() => money(Number.POSITIVE_INFINITY, 'GBP')).toThrow(MoneyError);
  });

  it('rejects unsupported currencies', () => {
    expect(() => money(100, 'USD' as never)).toThrow(MoneyError);
    expect(isCurrency('GBP')).toBe(true);
    expect(isCurrency('EUR')).toBe(true);
    expect(isCurrency('USD')).toBe(false);
  });

  it('adds and subtracts within one currency', () => {
    expect(addMoney(money(150, 'GBP'), money(250, 'GBP'))).toEqual(money(400, 'GBP'));
    expect(subtractMoney(money(150, 'EUR'), money(250, 'EUR'))).toEqual(money(-100, 'EUR'));
  });

  it('never combines different currencies', () => {
    expect(() => addMoney(money(1, 'GBP'), money(1, 'EUR'))).toThrow(/Currency mismatch/);
    expect(() => subtractMoney(money(1, 'EUR'), money(1, 'GBP'))).toThrow(/Currency mismatch/);
  });

  it('renders exact decimal strings', () => {
    expect(toDecimalString(money(0, 'GBP'))).toBe('0.00');
    expect(toDecimalString(money(5, 'GBP'))).toBe('0.05');
    expect(toDecimalString(money(-5, 'EUR'))).toBe('-0.05');
    expect(toDecimalString(money(123456789, 'EUR'))).toBe('1234567.89');
    expect(toDecimalString(money(Number.MAX_SAFE_INTEGER, 'GBP'))).toBe('90071992547409.91');
  });

  it('formats per market locale', () => {
    expect(formatMoney(money(123456, 'GBP'), 'en-GB')).toBe('£1,234.56');
    expect(formatMoney(money(123456, 'EUR'), 'en-IE')).toBe('€1,234.56');
    // de-DE uses a non-breaking space before the symbol.
    expect(formatMoney(money(123456, 'EUR'), 'de-DE')).toBe('1.234,56 €');
  });

  it('formats large amounts without float precision loss', () => {
    expect(formatMoney(money(Number.MAX_SAFE_INTEGER, 'GBP'), 'en-GB')).toBe(
      '£90,071,992,547,409.91',
    );
  });
});

describe('parseDecimalMoney', () => {
  it('reads typed amounts exactly, without float arithmetic', () => {
    expect(parseDecimalMoney('2.50', 'GBP')).toEqual({ amountMinor: 250, currency: 'GBP' });
    expect(parseDecimalMoney('0.99', 'EUR')).toEqual({ amountMinor: 99, currency: 'EUR' });
    expect(parseDecimalMoney('12', 'GBP')).toEqual({ amountMinor: 1200, currency: 'GBP' });
    expect(parseDecimalMoney(' 1.5 ', 'GBP')).toEqual({ amountMinor: 150, currency: 'GBP' });
    // 0.1 + 0.2 style inputs stay exact.
    expect(parseDecimalMoney('0.30', 'GBP').amountMinor).toBe(30);
  });

  it.each(['', '-1.00', '1.234', '1,50', '1e3', '£2.50', '.50', '2.'])('rejects %j', (input) => {
    expect(() => parseDecimalMoney(input, 'GBP')).toThrow(MoneyError);
  });
});
