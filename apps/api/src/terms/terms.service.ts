import { Inject, Injectable } from '@nestjs/common';
import type { MarketTermsResponse, TermsAcceptance, TermsVersion } from '@hv/contracts';
import { type Database, type DbExecutor, withTransaction } from '@hv/db';
import { Errors } from '../common/errors';
import type { MarketContext } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import type { CheckoutIdentity } from '../cart/checkout-identity';
import {
  type AcceptingIdentity,
  TermsRepository,
  type TermsVersionRecord,
} from './terms.repository';

/**
 * Market terms and accepting them (B12, ADR-0031).
 *
 * A market's active terms version is what a checkout is placed under. Without
 * one, no order can be created — but the market is still enabled and still
 * browsable, which is why this gate lives here and not in
 * `hv_market_missing_settings`.
 *
 * Nothing here carries the wording. Phase 12 and legal own that; Phase 5 owns
 * which version is current and who agreed to it.
 */
@Injectable()
export class TermsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly terms: TermsRepository,
  ) {}

  /** What a customer needs to know before checking out in this market. */
  async marketTerms(
    market: MarketContext,
    identity: CheckoutIdentity | null,
  ): Promise<MarketTermsResponse> {
    const active = await this.terms.activeVersion(this.db, market.id);
    const accepted =
      active && identity
        ? (await this.terms.findAcceptance(this.db, active.id, accepting(identity))) !== null
        : null;
    return {
      active: active ? this.toDto(market, active) : null,
      // The one field P5-7's gate turns on: no active version, no order.
      checkoutAllowed: active !== null,
      accepted: identity ? (accepted ?? false) : null,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Records agreement to the market's active terms.
   *
   * The version the customer saw is sent back and checked against the active
   * one. A page left open while legal published a new revision would otherwise
   * record agreement to wording nobody was shown — the one thing an acceptance
   * record exists to rule out.
   */
  async accept(
    market: MarketContext,
    identity: CheckoutIdentity,
    version: string,
  ): Promise<TermsAcceptance> {
    const who = accepting(identity);
    return withTransaction(this.db, async (trx) => {
      const active = await this.terms.activeVersion(trx, market.id);
      if (!active) {
        throw Errors.conflict(
          'TERMS_UNAVAILABLE',
          'This market has no terms to accept yet, so an order cannot be placed.',
        );
      }
      if (active.version !== version) {
        throw Errors.conflict(
          'TERMS_VERSION_STALE',
          'The terms have changed since they were shown. Read them again and accept.',
          { version: active.version },
        );
      }

      await this.terms.accept(trx, {
        marketId: market.id,
        termsVersionId: active.id,
        identity: who,
      });
      // Read back rather than trust the insert: ON CONFLICT DO NOTHING means a
      // second acceptance writes nothing, and the answer is the first one.
      const acceptance = await this.terms.findAcceptance(trx, active.id, who);
      if (!acceptance) throw new Error('terms acceptance was not recorded');
      return {
        termsVersion: this.toDto(market, active),
        acceptedAt: acceptance.acceptedAt.toISOString(),
        acceptedBy: acceptance.acceptedBy,
      };
    });
  }

  /**
   * Whether this identity may proceed to an order in this market, and under
   * which version.
   *
   * Takes an executor so order creation can ask inside its own transaction —
   * the answer has to be true at the moment the order is written, not a
   * moment earlier. The two failures are reported separately because they are
   * different situations for the customer: a market with no terms is nobody's
   * fault, and an unaccepted one just needs a tick.
   */
  async acceptedActiveVersionIn(
    db: DbExecutor,
    market: MarketContext,
    identity: CheckoutIdentity,
  ): Promise<
    | { reason: 'ok'; version: TermsVersionRecord }
    | { reason: 'no_active_version' }
    | { reason: 'not_accepted' }
  > {
    const active = await this.terms.activeVersion(db, market.id);
    if (!active) return { reason: 'no_active_version' };
    const acceptance = await this.terms.findAcceptance(db, active.id, accepting(identity));
    return acceptance ? { reason: 'ok', version: active } : { reason: 'not_accepted' };
  }

  /** The label of a version an order was placed under. */
  async versionLabel(db: DbExecutor, termsVersionId: string): Promise<string> {
    const version = await this.terms.findAnyById(db, termsVersionId);
    return version?.version ?? '';
  }

  toDto(market: MarketContext, record: TermsVersionRecord): TermsVersion {
    return {
      id: record.id,
      market: market.code,
      version: record.version,
      publishedAt: record.publishedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}

/**
 * The checkout identity, as the acceptance record stores it.
 *
 * A guest stays a guest: no user row is created for them, and nothing here
 * turns a guest session into an account (ADR-0029).
 */
function accepting(identity: CheckoutIdentity): AcceptingIdentity {
  return identity.kind === 'user'
    ? { kind: 'user', userId: identity.auth.userId }
    : { kind: 'guest', guestSessionId: identity.guest.guestSessionId };
}
