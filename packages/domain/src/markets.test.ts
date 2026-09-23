import { describe, expect, it } from 'vitest';
import {
  MARKET_DEFINITIONS,
  MarketRuleError,
  assertMarketCurrency,
  assertSameMarket,
  enablementBlockers,
  isMarketAvailable,
  isMarketCode,
  parseEnabledMarkets,
} from './markets';

describe('market definitions', () => {
  it('pins each market to its currency and locale (SPEC §7)', () => {
    expect(MARKET_DEFINITIONS).toEqual({
      uk: { code: 'uk', currency: 'GBP', locale: 'en-GB' },
      ie: { code: 'ie', currency: 'EUR', locale: 'en-IE' },
      de: { code: 'de', currency: 'EUR', locale: 'de-DE' },
    });
  });

  it('recognizes only the three market codes, case-sensitively', () => {
    expect(['uk', 'ie', 'de'].every(isMarketCode)).toBe(true);
    expect(['UK', 'gb', 'fr', '', 'u k'].some(isMarketCode)).toBe(false);
  });
});

describe('market isolation', () => {
  it('accepts the market currency and rejects any other', () => {
    expect(() => assertMarketCurrency('uk', 'GBP')).not.toThrow();
    expect(() => assertMarketCurrency('ie', 'EUR')).not.toThrow();
    expect(() => assertMarketCurrency('uk', 'EUR')).toThrow(MarketRuleError);
    expect(() => assertMarketCurrency('ie', 'GBP')).toThrow(MarketRuleError);
    expect(() => assertMarketCurrency('de', 'GBP')).toThrow(MarketRuleError);
  });

  it('rejects an entity from another market', () => {
    expect(() => assertSameMarket('uk', 'uk')).not.toThrow();
    expect(() => assertSameMarket('uk', 'ie')).toThrow(/Cross-market/);
    // Same currency is not the same market.
    expect(() => assertSameMarket('ie', 'de')).toThrow(MarketRuleError);
  });
});

describe('ENABLED_MARKETS kill switch', () => {
  it('parses a comma-separated list', () => {
    expect([...parseEnabledMarkets('uk,ie')]).toEqual(['uk', 'ie']);
    expect([...parseEnabledMarkets(' uk , ie ')]).toEqual(['uk', 'ie']);
    expect(parseEnabledMarkets('').size).toBe(0);
  });

  it('rejects unknown and duplicate codes instead of ignoring them', () => {
    expect(() => parseEnabledMarkets('uk,fr')).toThrow(/Unknown market code "fr"/);
    expect(() => parseEnabledMarkets('uk,UK')).toThrow(/Unknown market code "UK"/);
    expect(() => parseEnabledMarkets('uk,uk')).toThrow(/listed twice/);
  });
});

describe('market availability (gate layers 2 and 3)', () => {
  const env = parseEnabledMarkets('uk,ie');

  it('requires both the environment and the database', () => {
    expect(isMarketAvailable({ code: 'uk', isEnabled: true }, env)).toBe(true);
    expect(isMarketAvailable({ code: 'uk', isEnabled: false }, env)).toBe(false);
    expect(isMarketAvailable({ code: 'de', isEnabled: true }, env)).toBe(false);
    expect(isMarketAvailable({ code: 'de', isEnabled: false }, parseEnabledMarkets('de'))).toBe(
      false,
    );
  });
});

describe('enablement blockers', () => {
  it('blocks a legally gated market without approval', () => {
    expect(
      enablementBlockers({
        requiresLegalApproval: true,
        legalApprovedAt: null,
        missingSettings: [],
      }),
    ).toEqual([{ kind: 'legal_approval_missing' }]);
  });

  it('blocks any market with unset compliance settings', () => {
    expect(
      enablementBlockers({
        requiresLegalApproval: false,
        legalApprovedAt: null,
        missingSettings: ['min_age'],
      }),
    ).toEqual([{ kind: 'compliance_settings_missing', settings: ['min_age'] }]);
  });

  it('reports every blocker at once', () => {
    expect(
      enablementBlockers({
        requiresLegalApproval: true,
        legalApprovedAt: null,
        missingSettings: ['min_age', 'self_exclusion_required'],
      }),
    ).toHaveLength(2);
  });

  it('allows enabling once approval and settings are present', () => {
    expect(
      enablementBlockers({
        requiresLegalApproval: true,
        legalApprovedAt: new Date('2026-01-01T00:00:00Z'),
        missingSettings: [],
      }),
    ).toEqual([]);
    expect(
      enablementBlockers({
        requiresLegalApproval: false,
        legalApprovedAt: null,
        missingSettings: [],
      }),
    ).toEqual([]);
  });
});
