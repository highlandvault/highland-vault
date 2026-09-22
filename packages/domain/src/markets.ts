/**
 * Market rules (SPEC §7, ADR-0004, ADR-0005, ADR-0016, Revision 2 B8).
 *
 * The database is the final authority (markets_* constraints and triggers in
 * migration 0004). These pure functions give the API the same answers up front,
 * so it can explain a refusal instead of surfacing a constraint violation.
 */
import type { Currency } from './money';

export const MARKET_CODES = ['uk', 'ie', 'de'] as const;
export type MarketCode = (typeof MARKET_CODES)[number];

export interface MarketDefinition {
  readonly code: MarketCode;
  readonly currency: Currency;
  readonly locale: string;
}

/** Fixed by SPEC §7 and pinned in the database (markets_known_definition). */
export const MARKET_DEFINITIONS: Readonly<Record<MarketCode, MarketDefinition>> = Object.freeze({
  uk: { code: 'uk', currency: 'GBP', locale: 'en-GB' },
  ie: { code: 'ie', currency: 'EUR', locale: 'en-IE' },
  de: { code: 'de', currency: 'EUR', locale: 'de-DE' },
});

export function isMarketCode(value: unknown): value is MarketCode {
  return typeof value === 'string' && (MARKET_CODES as readonly string[]).includes(value);
}

export class MarketRuleError extends Error {
  override readonly name = 'MarketRuleError';
}

/**
 * Market isolation: anything priced or paid inside a market uses that market's
 * currency (ADR-0004). Orders and draws (Phases 3 and 5) are also pinned to it
 * by a composite foreign key on markets (id, currency).
 */
export function assertMarketCurrency(market: MarketCode, currency: Currency): void {
  const expected = MARKET_DEFINITIONS[market].currency;
  if (currency !== expected) {
    throw new MarketRuleError(`Market ${market} trades in ${expected}, not ${currency}`);
  }
}

/** Market isolation: an entity from one market can never be used in another market's context. */
export function assertSameMarket(context: MarketCode, entityMarket: MarketCode): void {
  if (context !== entityMarket) {
    throw new MarketRuleError(`Cross-market access: ${entityMarket} entity in ${context} context`);
  }
}

/**
 * Parses the ENABLED_MARKETS kill switch ("uk,ie"). Unknown or duplicate codes
 * are configuration errors, not silently ignored.
 */
export function parseEnabledMarkets(value: string): ReadonlySet<MarketCode> {
  const codes = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const result = new Set<MarketCode>();
  for (const code of codes) {
    if (!isMarketCode(code)) {
      throw new MarketRuleError(`Unknown market code "${code}"`);
    }
    if (result.has(code)) {
      throw new MarketRuleError(`Market code "${code}" is listed twice`);
    }
    result.add(code);
  }
  return result;
}

export interface MarketGateState {
  readonly code: MarketCode;
  readonly isEnabled: boolean;
}

/**
 * Layers 2 and 3 of the market gate: a market is available to customers only if
 * the environment allows it AND it is enabled in the database. Either one alone
 * is not enough, and the answer never depends on what the frontend shows.
 */
export function isMarketAvailable(
  market: MarketGateState,
  environmentAllowed: ReadonlySet<MarketCode>,
): boolean {
  return environmentAllowed.has(market.code) && market.isEnabled;
}

export type EnablementBlocker =
  | { readonly kind: 'legal_approval_missing' }
  | { readonly kind: 'compliance_settings_missing'; readonly settings: readonly string[] };

export interface EnablementInput {
  readonly requiresLegalApproval: boolean;
  readonly legalApprovedAt: Date | null;
  /** Names of required compliance settings that are unset (from hv_market_missing_settings). */
  readonly missingSettings: readonly string[];
}

/** Everything that stops a market from being enabled. Empty means it may be enabled. */
export function enablementBlockers(input: EnablementInput): EnablementBlocker[] {
  const blockers: EnablementBlocker[] = [];
  if (input.requiresLegalApproval && input.legalApprovedAt === null) {
    blockers.push({ kind: 'legal_approval_missing' });
  }
  if (input.missingSettings.length > 0) {
    blockers.push({ kind: 'compliance_settings_missing', settings: [...input.missingSettings] });
  }
  return blockers;
}
