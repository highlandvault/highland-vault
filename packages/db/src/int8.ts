import pg from 'pg';

/**
 * PostgreSQL `bigint` (int8) values are returned as JS numbers only when they
 * are exactly representable. Money is stored as bigint minor units, so a silent
 * precision loss would corrupt balances; instead we fail loudly.
 */
export function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw new RangeError(`int8 value ${value} is outside the safe integer range`);
  }
  return parsed;
}

const INT8_OID = 20;
const INT8_ARRAY_OID = 1016;

type TextParser = (value: string) => unknown;
// pg's typings only enumerate scalar builtin OIDs; this view accepts any OID.
const defaultParser = pg.types.getTypeParser as (
  oid: number,
  format?: 'text' | 'binary',
) => TextParser;

/** Per-pool type parsers (avoids mutating pg's global parser registry). */
export const pgTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary'): TextParser => {
    if (format !== 'binary') {
      if (oid === INT8_OID) {
        return parseInt8;
      }
      if (oid === INT8_ARRAY_OID) {
        const parseArray = defaultParser(INT8_ARRAY_OID, 'text') as (
          value: string,
        ) => (string | null)[];
        return (value) => parseArray(value).map((item) => (item === null ? null : parseInt8(item)));
      }
    }
    return defaultParser(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};
